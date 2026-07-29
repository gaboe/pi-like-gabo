#define _DARWIN_C_SOURCE 1
#define _GNU_SOURCE 1
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/xattr.h>
#elif defined(__APPLE__)
#include <sys/acl.h>
#include <sys/stdio.h>
#include <sys/xattr.h>
#else
#error "safe-writer supports only Linux and macOS ACL APIs"
#endif

#if !defined(O_CLOEXEC) || !defined(O_DIRECTORY) || !defined(O_NOFOLLOW) || \
    !defined(AT_SYMLINK_NOFOLLOW) || !defined(AT_REMOVEDIR)
#error "safe-writer requires descriptor-relative no-follow platform APIs"
#endif

#define ROOT_FD 3
#define MAX_PATH_BYTES 4096
#define MAX_CONTENT_BYTES (4U * 1024U * 1024U)
#define MAX_COMPONENT_BYTES 255
#define MAX_FINGERPRINT_BYTES (1024U * 1024U)
#define MAX_RECEIPT_BYTES (2U * MAX_FINGERPRINT_BYTES + 48U)
#define FINGERPRINT_HEADER_BYTES 136U
#define FINGERPRINT_MAGIC "PISWFP2\0"
#define RECEIPT_MAGIC "PISWRC2\0"
#define RECEIPT_RECORD_BYTES 24U
#define RECEIPT_STAGED 0U
#define RECEIPT_PUBLISHED 1U

#if defined(__linux__)
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1U << 0)
#endif
#ifndef RENAME_EXCHANGE
#define RENAME_EXCHANGE (1U << 1)
#endif
#ifndef SYS_renameat2
#error "safe-writer requires Linux renameat2 syscall support"
#endif
#endif

static volatile sig_atomic_t committed = 0;
static volatile sig_atomic_t namespace_published = 0;
static volatile sig_atomic_t staging_active = 0;
static volatile sig_atomic_t staged_file_active = 0;
static int staging_parent = -1;
static int staging_directory = -1;
static char staging_name[96];
static const char staged_file_name[] = "file";

static void remove_staging(void) {
  if (!staging_active || staging_parent < 0) return;
  if (staged_file_active && staging_directory >= 0)
    unlinkat(staging_directory, staged_file_name, 0);
  staged_file_active = 0;
  if (staging_directory >= 0) {
    close(staging_directory);
    staging_directory = -1;
  }
  unlinkat(staging_parent, staging_name, AT_REMOVEDIR);
  fsync(staging_parent);
  staging_active = 0;
}

static void terminate(int signal_number) {
  (void)signal_number;
  if (committed) return;
  remove_staging();
  _exit(2);
}

static void install_signal_handler(void) {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = terminate;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0) _exit(2);
}

static void fail(const char *code, const char *detail) {
  remove_staging();
  if (namespace_published) code = "AMBIGUOUS";
  if (detail && *detail) fprintf(stderr, "SAFE_WRITE:%s:%s\n", code, detail);
  else fprintf(stderr, "SAFE_WRITE:%s\n", code);
  exit(1);
}

#ifdef PI_SAFE_WRITER_TESTING
static int test_fault(const char *variable, const char *value) {
  const char *requested = getenv(variable);
  return requested && strcmp(requested, value) == 0;
}
#else
static int test_fault(const char *variable, const char *value) {
  (void)variable;
  (void)value;
  return 0;
}
#endif

struct file_snapshot {
  struct stat status;
  struct timespec ctime;
  struct timespec mtime;
  uint64_t generation;
  int generation_available;
};

static int capture_snapshot(int fd, struct file_snapshot *result) {
  if (fstat(fd, &result->status) != 0) return -1;
#if defined(__APPLE__)
  result->ctime = result->status.st_ctimespec;
  result->mtime = result->status.st_mtimespec;
  result->generation = (uint64_t)result->status.st_gen;
  result->generation_available = 1;
#else
  result->ctime = result->status.st_ctim;
  result->mtime = result->status.st_mtim;
  result->generation = 0;
  result->generation_available = 0;
#endif
  if (result->ctime.tv_nsec < 0 || result->ctime.tv_nsec >= 1000000000L ||
      result->mtime.tv_nsec < 0 || result->mtime.tv_nsec >= 1000000000L)
    return -1;
  return 0;
}

static int snapshots_equal(const struct file_snapshot *first,
                           const struct file_snapshot *second) {
  return first->status.st_dev == second->status.st_dev &&
         first->status.st_ino == second->status.st_ino &&
         first->status.st_mode == second->status.st_mode &&
         first->status.st_nlink == second->status.st_nlink &&
         first->status.st_uid == second->status.st_uid &&
         first->status.st_gid == second->status.st_gid &&
         first->status.st_size == second->status.st_size &&
         first->ctime.tv_sec == second->ctime.tv_sec &&
         first->ctime.tv_nsec == second->ctime.tv_nsec &&
         first->mtime.tv_sec == second->mtime.tv_sec &&
         first->mtime.tv_nsec == second->mtime.tv_nsec &&
         first->generation_available == second->generation_available &&
         (!first->generation_available ||
          first->generation == second->generation);
}

static void test_stop(const char *stage);
static void write_exact(int fd, const unsigned char *buffer, size_t length);

#if defined(__linux__)
static int clear_and_verify_acl(int fd, const char *scope) {
  static const char *const names[] = {
      "system.posix_acl_access",
      "system.posix_acl_default",
  };
  char fault[64];
  snprintf(fault, sizeof(fault), "%s-clear", scope);
  if (test_fault("PI_SAFE_WRITER_TEST_ACL_FAIL", fault)) return -1;

  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++) {
    if (fremovexattr(fd, names[index]) == 0 || errno == ENODATA) continue;
    if (errno != EOPNOTSUPP && errno != ENOTSUP) return -1;
  }

  snprintf(fault, sizeof(fault), "%s-verify", scope);
  if (test_fault("PI_SAFE_WRITER_TEST_ACL_FAIL", fault)) return -1;
  ssize_t length = flistxattr(fd, NULL, 0);
  if (length < 0) return errno == EOPNOTSUPP || errno == ENOTSUP ? 0 : -1;
  char *list = malloc((size_t)(length > 0 ? length : 1));
  if (!list) return -1;
  ssize_t listed = flistxattr(fd, list, (size_t)length);
  if (listed < 0) {
    int unsupported = errno == EOPNOTSUPP || errno == ENOTSUP;
    free(list);
    return unsupported ? 0 : -1;
  }
  int clean = listed == length;
  for (ssize_t offset = 0; clean && offset < listed;) {
    size_t remaining = (size_t)(listed - offset);
    size_t name_length = strnlen(list + offset, remaining);
    if (name_length == remaining) {
      clean = 0;
      break;
    }
    for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); index++)
      if (strcmp(list + offset, names[index]) == 0) clean = 0;
    offset += (ssize_t)name_length + 1;
  }
  free(list);
  return clean ? 0 : -1;
}
#elif defined(__APPLE__)
static int clear_and_verify_acl(int fd, const char *scope) {
  char fault[64];
  snprintf(fault, sizeof(fault), "%s-clear", scope);
  if (test_fault("PI_SAFE_WRITER_TEST_ACL_FAIL", fault)) return -1;

  acl_t empty = acl_init(0);
  if (!empty) return -1;
  int set_result = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED);
  int set_error = errno;
  acl_free(empty);
  if (set_result != 0 && set_error != EOPNOTSUPP && set_error != ENOTSUP)
    return -1;

  snprintf(fault, sizeof(fault), "%s-verify", scope);
  if (test_fault("PI_SAFE_WRITER_TEST_ACL_FAIL", fault)) return -1;
  errno = 0;
  acl_t current = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!current)
    return errno == ENOENT || errno == EOPNOTSUPP || errno == ENOTSUP ? 0 : -1;
  acl_entry_t entry;
  errno = 0;
  int entry_result = acl_get_entry(current, ACL_FIRST_ENTRY, &entry);
  int entry_error = errno;
  acl_free(current);
  return entry_result == -1 && entry_error == EINVAL ? 0 : -1;
}
#endif

static int unsupported_metadata_error(void) {
  return errno == EOPNOTSUPP || errno == ENOTSUP;
}

static ssize_t list_xattrs(int fd, char *buffer, size_t size) {
#if defined(__linux__)
  return flistxattr(fd, buffer, size);
#else
  return flistxattr(fd, buffer, size, 0);
#endif
}

static ssize_t get_xattr(int fd, const char *name, void *value, size_t size) {
#if defined(__linux__)
  return fgetxattr(fd, name, value, size);
#else
  return fgetxattr(fd, name, value, size, 0, 0);
#endif
}

static int set_xattr(int fd, const char *name, const void *value, size_t size) {
#if defined(__linux__)
  return fsetxattr(fd, name, value, size, 0);
#else
  return fsetxattr(fd, name, value, size, 0, 0);
#endif
}

static int remove_xattr(int fd, const char *name) {
#if defined(__linux__)
  return fremovexattr(fd, name);
#else
  return fremovexattr(fd, name, 0);
#endif
}

static int load_xattr_names(int fd, char **names, size_t *length) {
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0) return -1;
  ssize_t required = list_xattrs(fd, NULL, 0);
  if (required < 0) {
    if (!unsupported_metadata_error()) return -1;
    if (capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
      return -1;
    *names = NULL;
    *length = 0;
    return 0;
  }
  char *buffer = malloc((size_t)(required > 0 ? required : 1));
  if (!buffer) return -1;
  ssize_t actual = list_xattrs(fd, buffer, (size_t)required);
  if (actual != required || capture_snapshot(fd, &after) != 0 ||
      !snapshots_equal(&before, &after)) {
    free(buffer);
    return -1;
  }
  for (ssize_t offset = 0; offset < actual;) {
    size_t remaining = (size_t)(actual - offset);
    size_t name_length = strnlen(buffer + offset, remaining);
    if (name_length == 0 || name_length == remaining) {
      free(buffer);
      return -1;
    }
    offset += (ssize_t)name_length + 1;
  }
  *names = buffer;
  *length = (size_t)actual;
  return 0;
}

static int load_xattr_value(int fd, const char *name,
                            unsigned char **value, size_t *length) {
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0) return -1;
  ssize_t required = get_xattr(fd, name, NULL, 0);
  if (required < 0) return -1;
  unsigned char *buffer = malloc((size_t)(required > 0 ? required : 1));
  if (!buffer) return -1;
  ssize_t actual = get_xattr(fd, name, buffer, (size_t)required);
  if (actual != required || capture_snapshot(fd, &after) != 0 ||
      !snapshots_equal(&before, &after)) {
    free(buffer);
    return -1;
  }
  *value = buffer;
  *length = (size_t)actual;
  return 0;
}

static size_t xattr_name_count(const char *names, size_t length) {
  size_t count = 0;
  for (size_t offset = 0; offset < length; offset += strlen(names + offset) + 1)
    count++;
  return count;
}

static int xattrs_equal(int source, int destination) {
  struct file_snapshot source_before, source_after;
  struct file_snapshot destination_before, destination_after;
  char *source_names, *destination_names;
  size_t source_length, destination_length;
  if (capture_snapshot(source, &source_before) != 0 ||
      capture_snapshot(destination, &destination_before) != 0 ||
      load_xattr_names(source, &source_names, &source_length) != 0) return -1;
  if (load_xattr_names(destination, &destination_names, &destination_length) != 0) {
    free(source_names);
    return -1;
  }
  int equal = xattr_name_count(source_names, source_length) ==
              xattr_name_count(destination_names, destination_length);
  for (size_t offset = 0; equal && offset < source_length;
       offset += strlen(source_names + offset) + 1) {
    unsigned char *source_value, *destination_value;
    size_t source_size, destination_size;
    if (load_xattr_value(source, source_names + offset, &source_value,
                         &source_size) != 0) {
      equal = -1;
      break;
    }
    if (load_xattr_value(destination, source_names + offset, &destination_value,
                         &destination_size) != 0) {
      free(source_value);
      equal = errno == ENODATA ? 0 : -1;
      break;
    }
    equal = source_size == destination_size &&
            memcmp(source_value, destination_value, source_size) == 0;
    free(source_value);
    free(destination_value);
  }
  free(source_names);
  free(destination_names);
  if (capture_snapshot(source, &source_after) != 0 ||
      capture_snapshot(destination, &destination_after) != 0 ||
      !snapshots_equal(&source_before, &source_after) ||
      !snapshots_equal(&destination_before, &destination_after))
    return -1;
  return equal;
}

static int copy_xattrs(int source, int destination) {
  struct file_snapshot source_before, source_after;
  char *names;
  size_t length;
  if (capture_snapshot(source, &source_before) != 0 ||
      load_xattr_names(destination, &names, &length) != 0) return -1;
  for (size_t offset = 0; offset < length; offset += strlen(names + offset) + 1)
    if (remove_xattr(destination, names + offset) != 0 && errno != ENODATA) {
      free(names);
      return -1;
    }
  free(names);

  if (load_xattr_names(source, &names, &length) != 0) return -1;
  for (size_t offset = 0; offset < length; offset += strlen(names + offset) + 1) {
    unsigned char *value = NULL;
    size_t value_length;
    if (load_xattr_value(source, names + offset, &value, &value_length) != 0 ||
        set_xattr(destination, names + offset, value, value_length) != 0) {
      free(value);
      free(names);
      return -1;
    }
    free(value);
  }
  free(names);
  if (capture_snapshot(source, &source_after) != 0 ||
      !snapshots_equal(&source_before, &source_after))
    return -1;
  return xattrs_equal(source, destination) == 1 ? 0 : -1;
}

#if defined(__APPLE__)
static int load_acl(int fd, acl_t *result) {
  errno = 0;
  *result = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (*result) return 1;
  return errno == ENOENT || unsupported_metadata_error() ? 0 : -1;
}
#endif

static int load_file_flags(int fd, uint64_t *result) {
#if defined(__linux__)
  int flags;
  if (ioctl(fd, FS_IOC_GETFLAGS, &flags) != 0) return -1;
  *result = (uint64_t)(unsigned int)flags;
#else
  struct stat status;
  if (fstat(fd, &status) != 0) return -1;
  *result = (uint64_t)status.st_flags;
#endif
  return 0;
}

static int target_has_relevant_flags(int fd) {
  uint64_t flags;
  if (load_file_flags(fd, &flags) != 0) return -1;
#if defined(__linux__)
  return (flags & ~(uint64_t)(FS_EXTENT_FL | FS_INDEX_FL)) != 0;
#else
  return flags != 0;
#endif
}

static int acl_state(int fd) {
#if defined(__linux__)
  (void)fd;
  return 0;
#else
  acl_t acl;
  int state = load_acl(fd, &acl);
  if (state > 0) acl_free(acl);
  return state;
#endif
}

static void put_u64(unsigned char *output, uint64_t value) {
  for (unsigned index = 0; index < 8; index++)
    output[index] = (unsigned char)(value >> (56U - index * 8U));
}

static int take_u64(const unsigned char **cursor, const unsigned char *end,
                    uint64_t *value) {
  if ((size_t)(end - *cursor) < 8) return -1;
  *value = 0;
  for (unsigned index = 0; index < 8; index++)
    *value = (*value << 8U) | *(*cursor)++;
  return 0;
}

static int capture_fingerprint_with_hook(int fd, unsigned char **output,
                                         size_t *output_length,
                                         const char *scan_hook) {
  struct file_snapshot before, after;
  uint64_t flags;
  char *names = NULL;
  size_t names_length = 0, total = FINGERPRINT_HEADER_BYTES;
  if (capture_snapshot(fd, &before) != 0 ||
      !S_ISREG(before.status.st_mode) || before.status.st_nlink != 1 ||
      before.status.st_size < 0 || load_file_flags(fd, &flags) != 0 ||
      acl_state(fd) != 0 || load_xattr_names(fd, &names, &names_length) != 0)
    return -1;

  size_t count = 0;
  for (size_t offset = 0; offset < names_length;
       offset += strlen(names + offset) + 1) {
    unsigned char *value = NULL;
    size_t value_length;
    size_t name_length = strlen(names + offset);
    if (load_xattr_value(fd, names + offset, &value, &value_length) != 0 ||
        name_length > MAX_FINGERPRINT_BYTES ||
        value_length > MAX_FINGERPRINT_BYTES ||
        total > MAX_FINGERPRINT_BYTES - 16 - name_length ||
        total + 16 + name_length > MAX_FINGERPRINT_BYTES - value_length) {
      free(value);
      free(names);
      return -1;
    }
    total += 16 + name_length + value_length;
    count++;
    free(value);
  }

  unsigned char *fingerprint = malloc(total);
  if (!fingerprint) {
    free(names);
    return -1;
  }
  memcpy(fingerprint, FINGERPRINT_MAGIC, 8);
  uint64_t fields[] = {
      (uint64_t)before.status.st_dev,
      (uint64_t)before.status.st_ino,
      (uint64_t)before.status.st_mode,
      (uint64_t)before.status.st_nlink,
      (uint64_t)before.status.st_uid,
      (uint64_t)before.status.st_gid,
      (uint64_t)before.status.st_size,
      flags,
      0,
      (uint64_t)count,
      (uint64_t)before.ctime.tv_sec,
      (uint64_t)before.ctime.tv_nsec,
      (uint64_t)before.mtime.tv_sec,
      (uint64_t)before.mtime.tv_nsec,
      (uint64_t)before.generation_available,
      before.generation,
  };
  unsigned char *cursor = fingerprint + 8;
  for (size_t index = 0; index < sizeof(fields) / sizeof(fields[0]); index++) {
    put_u64(cursor, fields[index]);
    cursor += 8;
  }
  for (size_t offset = 0; offset < names_length;
       offset += strlen(names + offset) + 1) {
    unsigned char *value = NULL;
    size_t value_length;
    size_t name_length = strlen(names + offset);
    if (load_xattr_value(fd, names + offset, &value, &value_length) != 0 ||
        (size_t)(fingerprint + total - cursor) < 16 + name_length ||
        (size_t)(fingerprint + total - cursor) - 16 - name_length < value_length) {
      free(value);
      free(fingerprint);
      free(names);
      return -1;
    }
    put_u64(cursor, name_length);
    put_u64(cursor + 8, value_length);
    cursor += 16;
    memcpy(cursor, names + offset, name_length);
    cursor += name_length;
    memcpy(cursor, value, value_length);
    cursor += value_length;
    free(value);
  }
  free(names);
  if (scan_hook) test_stop(scan_hook);
  if (cursor != fingerprint + total || capture_snapshot(fd, &after) != 0 ||
      !snapshots_equal(&before, &after)) {
    free(fingerprint);
    return -1;
  }
  *output = fingerprint;
  *output_length = total;
  return 0;
}

static int fingerprint_matches_with_hook(int fd,
                                         const unsigned char *fingerprint,
                                         size_t length,
                                         const char *scan_hook) {
  if (!fingerprint || length < FINGERPRINT_HEADER_BYTES ||
      length > MAX_FINGERPRINT_BYTES ||
      memcmp(fingerprint, FINGERPRINT_MAGIC, 8) != 0)
    return 0;
  const unsigned char *cursor = fingerprint + 8;
  const unsigned char *end = fingerprint + length;
  uint64_t fields[16];
  for (size_t index = 0; index < sizeof(fields) / sizeof(fields[0]); index++)
    if (take_u64(&cursor, end, &fields[index]) != 0) return 0;
  if (fields[11] >= 1000000000U || fields[13] >= 1000000000U ||
      fields[14] > 1U)
    return 0;

  struct file_snapshot before, after;
  uint64_t flags;
  char *names = NULL;
  size_t names_length;
  if (capture_snapshot(fd, &before) != 0 || load_file_flags(fd, &flags) != 0 ||
      acl_state(fd) != (int)fields[8] ||
      load_xattr_names(fd, &names, &names_length) != 0)
    return 0;
  int equal = S_ISREG(before.status.st_mode) && before.status.st_nlink == 1 &&
              (uint64_t)before.status.st_dev == fields[0] &&
              (uint64_t)before.status.st_ino == fields[1] &&
              (uint64_t)before.status.st_mode == fields[2] &&
              (uint64_t)before.status.st_nlink == fields[3] &&
              (uint64_t)before.status.st_uid == fields[4] &&
              (uint64_t)before.status.st_gid == fields[5] &&
              before.status.st_size >= 0 &&
              (uint64_t)before.status.st_size == fields[6] &&
              flags == fields[7] &&
              xattr_name_count(names, names_length) == fields[9] &&
              (uint64_t)before.ctime.tv_sec == fields[10] &&
              (uint64_t)before.ctime.tv_nsec == fields[11] &&
              (uint64_t)before.mtime.tv_sec == fields[12] &&
              (uint64_t)before.mtime.tv_nsec == fields[13] &&
              (uint64_t)before.generation_available == fields[14] &&
              (!before.generation_available || before.generation == fields[15]);
  for (uint64_t index = 0; equal && index < fields[9]; index++) {
    uint64_t name_length, value_length;
    if (take_u64(&cursor, end, &name_length) != 0 ||
        take_u64(&cursor, end, &value_length) != 0 || name_length == 0 ||
        name_length > (uint64_t)(end - cursor) ||
        value_length > (uint64_t)(end - cursor) - name_length ||
        name_length > SIZE_MAX - 1U ||
        memchr(cursor, '\0', (size_t)name_length) != NULL) {
      equal = 0;
      break;
    }
    char *name = malloc((size_t)name_length + 1);
    if (!name) {
      equal = 0;
      break;
    }
    memcpy(name, cursor, (size_t)name_length);
    name[name_length] = '\0';
    cursor += name_length;
    unsigned char *value = NULL;
    size_t actual_length;
    if (load_xattr_value(fd, name, &value, &actual_length) != 0 ||
        actual_length != value_length ||
        memcmp(value, cursor, actual_length) != 0)
      equal = 0;
    free(value);
    free(name);
    cursor += value_length;
  }
  free(names);
  if (scan_hook) test_stop(scan_hook);
  if (cursor != end || capture_snapshot(fd, &after) != 0 ||
      !snapshots_equal(&before, &after))
    equal = 0;
  return equal;
}

static int fingerprint_matches(int fd, const unsigned char *fingerprint,
                               size_t length) {
  return fingerprint_matches_with_hook(fd, fingerprint, length, NULL);
}

static int fingerprint_identity_matches(int fd,
                                        const unsigned char *fingerprint,
                                        size_t length) {
  if (!fingerprint || length < FINGERPRINT_HEADER_BYTES ||
      memcmp(fingerprint, FINGERPRINT_MAGIC, 8) != 0)
    return 0;
  const unsigned char *cursor = fingerprint + 8;
  const unsigned char *end = fingerprint + length;
  uint64_t device, inode;
  struct file_snapshot snapshot;
  return take_u64(&cursor, end, &device) == 0 &&
         take_u64(&cursor, end, &inode) == 0 &&
         capture_snapshot(fd, &snapshot) == 0 &&
         (uint64_t)snapshot.status.st_dev == device &&
         (uint64_t)snapshot.status.st_ino == inode;
}

struct receipt_fingerprints {
  const unsigned char *staged;
  size_t staged_length;
  const unsigned char *published;
  size_t published_length;
};

static void write_receipt_record(uint64_t phase,
                                 const unsigned char *fingerprint,
                                 size_t fingerprint_length) {
  unsigned char header[RECEIPT_RECORD_BYTES];
  memcpy(header, RECEIPT_MAGIC, 8);
  put_u64(header + 8, phase);
  put_u64(header + 16, (uint64_t)fingerprint_length);
  write_exact(STDOUT_FILENO, header, sizeof(header));
  write_exact(STDOUT_FILENO, fingerprint, fingerprint_length);
}

static int parse_receipt(const unsigned char *receipt, size_t receipt_length,
                         struct receipt_fingerprints *result) {
  memset(result, 0, sizeof(*result));
  if (receipt_length > MAX_RECEIPT_BYTES) return -1;
  const unsigned char *cursor = receipt;
  const unsigned char *end = receipt + receipt_length;
  while (cursor != end) {
    if ((size_t)(end - cursor) < RECEIPT_RECORD_BYTES ||
        memcmp(cursor, RECEIPT_MAGIC, 8) != 0)
      return -1;
    cursor += 8;
    uint64_t phase, fingerprint_length;
    if (take_u64(&cursor, end, &phase) != 0 ||
        take_u64(&cursor, end, &fingerprint_length) != 0 ||
        fingerprint_length > MAX_FINGERPRINT_BYTES ||
        fingerprint_length > (uint64_t)(end - cursor))
      return -1;
    if (phase == RECEIPT_STAGED && !result->staged && !result->published) {
      result->staged = cursor;
      result->staged_length = (size_t)fingerprint_length;
    } else if (phase == RECEIPT_PUBLISHED && !result->published) {
      result->published = cursor;
      result->published_length = (size_t)fingerprint_length;
    } else {
      return -1;
    }
    cursor += (size_t)fingerprint_length;
  }
  return result->staged || result->published ? 0 : -1;
}

static void require_replace_metadata(int fd, const struct stat *expected) {
  struct file_snapshot before, after;
  char *names;
  size_t names_length;
  if (capture_snapshot(fd, &before) != 0 ||
      before.status.st_dev != expected->st_dev ||
      before.status.st_ino != expected->st_ino ||
      before.status.st_uid != expected->st_uid ||
      before.status.st_gid != expected->st_gid ||
      (before.status.st_mode & 07777) != (expected->st_mode & 07777))
    fail("METADATA", "target ownership or mode changed");
  if (load_xattr_names(fd, &names, &names_length) != 0)
    fail("METADATA", "cannot inspect target extended attributes");
  free(names);
#if defined(__APPLE__)
  acl_t acl;
  int acl_state = load_acl(fd, &acl);
  if (acl_state < 0) fail("METADATA", "cannot inspect target ACL");
  if (acl_state > 0) {
    acl_free(acl);
    fail("METADATA", "target has an extended ACL");
  }
#endif
  int flags = target_has_relevant_flags(fd);
  if (flags != 0)
    fail("METADATA", flags > 0 ? "target has relevant file flags" :
                                 "cannot inspect target file flags");
  if (capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
    fail("METADATA", "target metadata changed during inspection");
}

static void require_equal_metadata(int source, int destination) {
  struct file_snapshot source_before, source_after;
  struct file_snapshot destination_before, destination_after;
  if (capture_snapshot(source, &source_before) != 0 ||
      capture_snapshot(destination, &destination_before) != 0 ||
      xattrs_equal(source, destination) != 1)
    fail("METADATA", "target extended attributes changed or were not preserved");
  if (target_has_relevant_flags(destination) != 0)
    fail("METADATA", "staged file has unsupported flags");
  if (capture_snapshot(source, &source_after) != 0 ||
      capture_snapshot(destination, &destination_after) != 0 ||
      !snapshots_equal(&source_before, &source_after) ||
      !snapshots_equal(&destination_before, &destination_after))
    fail("METADATA", "metadata changed during verification");
}

#ifdef PI_SAFE_WRITER_TESTING
static void test_add_xattr(int fd, const char *stage) {
  const char *requested = getenv("PI_SAFE_WRITER_TEST_ADD_XATTR");
  if (!requested || strcmp(requested, stage) != 0) return;
#if defined(__linux__)
  int result = fsetxattr(fd, "user.pi_safe_writer_test", "x", 1, 0);
#else
  int result = fsetxattr(fd, "user.pi_safe_writer_test", "x", 1, 0, 0);
#endif
  if (result != 0) fail("TEST", "cannot add target test xattr");
}
#else
static void test_add_xattr(int fd, const char *stage) {
  (void)fd;
  (void)stage;
}
#endif

static uint64_t parse_length(const char *input) {
  char *end = NULL;
  errno = 0;
  unsigned long long value = strtoull(input, &end, 10);
  if (errno || !end || *end || value > MAX_CONTENT_BYTES) fail("BOUNDS", "invalid content length");
  return (uint64_t)value;
}

static long parse_pid(const char *input) {
  if (!input || input[0] < '1' || input[0] > '9') fail("PROTOCOL", "invalid reconciliation PID");
  unsigned long value = 0;
  for (const char *cursor = input; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9' ||
        value > ((unsigned long)LONG_MAX - (unsigned long)(*cursor - '0')) / 10)
      fail("PROTOCOL", "invalid reconciliation PID");
    value = value * 10 + (unsigned long)(*cursor - '0');
  }
  return (long)value;
}

static void read_exact(int fd, unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(fd, buffer + offset, length - offset);
    if (count == 0) fail("PROTOCOL", "short input");
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("PROTOCOL", "input read failed");
    }
    offset += (size_t)count;
  }
}

static void write_exact(int fd, const unsigned char *buffer, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = write(fd, buffer + offset, length - offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("IO", "write failed");
    }
    offset += (size_t)count;
  }
}

static int valid_component(const char *component) {
  size_t length = strlen(component);
  return length > 0 && length <= MAX_COMPONENT_BYTES && strcmp(component, ".") != 0 &&
         strcmp(component, "..") != 0 && strcasecmp(component, ".git") != 0;
}

static int duplicate_root(void) {
  struct stat status;
  if (fstat(ROOT_FD, &status) != 0 || !S_ISDIR(status.st_mode)) fail("ROOT", "invalid pinned root descriptor");
  int fd = fcntl(ROOT_FD, F_DUPFD_CLOEXEC, 4);
  if (fd < 0) fail("ROOT", "cannot duplicate pinned root descriptor");
  return fd;
}

static int acquire_root_lock(void) {
  int fd = openat(ROOT_FD, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0 || flock(fd, LOCK_EX) != 0) {
    if (fd >= 0) close(fd);
    fail("LOCK", "cannot lock pinned root");
  }
  return fd;
}

static int walk_parent(const char *path, int create_directories, int missing_ok,
                       char final[MAX_COMPONENT_BYTES + 1]) {
  size_t length = strlen(path);
  if (!length || length > MAX_PATH_BYTES || path[0] == '/' || path[length - 1] == '/')
    fail("PATH", "path must be bounded and relative");

  char copy[MAX_PATH_BYTES + 1];
  memcpy(copy, path, length + 1);
  int directory = duplicate_root();
  char *cursor = copy;

  for (;;) {
    char *slash = strchr(cursor, '/');
    if (slash) *slash = '\0';
    if (!valid_component(cursor)) {
      close(directory);
      fail(strcasecmp(cursor, ".git") == 0 ? "GIT_ADMIN" : "PATH", "invalid path component");
    }
    if (!slash) {
      memcpy(final, cursor, strlen(cursor) + 1);
      return directory;
    }

    int next = openat(directory, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0 && errno == ENOENT && create_directories) {
      if (mkdirat(directory, cursor, 0777) != 0 && errno != EEXIST) {
        close(directory);
        fail("PATH", "cannot create directory");
      }
      next = openat(directory, cursor, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
      if (next < 0) {
        close(directory);
        fail("PATH", "cannot open created directory");
      }
      if (fsync(next) != 0 || fsync(directory) != 0) {
        close(next);
        close(directory);
        fail("IO", "cannot sync created directory");
      }
    }
    if (next < 0) {
      int missing = errno == ENOENT;
      close(directory);
      if (missing && missing_ok) return -1;
      fail(missing ? "NOT_FOUND" : "SYMLINK", "intermediate component is missing, non-directory, or symlink");
    }
    close(directory);
    directory = next;
    cursor = slash + 1;
  }
}

static void require_regular_single_link(const struct stat *status) {
  if (!S_ISREG(status->st_mode)) fail("TYPE", "target must be a regular file");
  if (status->st_nlink != 1) fail("HARDLINK", "target has multiple hard links");
}

static int same_identity(const struct stat *first, const struct stat *second) {
  return first->st_dev == second->st_dev && first->st_ino == second->st_ino;
}

static int named_identity(int directory, const char *name,
                          const struct stat *expected, struct stat *observed) {
  struct stat status;
  if (fstatat(directory, name, &status, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISREG(status.st_mode) || status.st_nlink != 1 ||
      (expected && !same_identity(&status, expected)))
    return 0;
  if (observed) *observed = status;
  return 1;
}

static void require_same_entry(int directory, const char *name, const struct stat *opened) {
  struct stat current;
  if (fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) != 0)
    fail("CAS", "target disappeared");
  require_regular_single_link(&current);
  if (!same_identity(&current, opened)) fail("CAS", "directory entry changed");
}

static int atomic_exchange(int first_directory, const char *first,
                           int second_directory, const char *second) {
#if defined(__linux__)
  return (int)syscall(SYS_renameat2, first_directory, first,
                      second_directory, second, RENAME_EXCHANGE);
#else
  return renameatx_np(first_directory, first, second_directory, second,
                      RENAME_SWAP);
#endif
}

static int atomic_noreplace(int source_directory, const char *source,
                            int destination_directory, const char *destination) {
#if defined(__linux__)
  return (int)syscall(SYS_renameat2, source_directory, source,
                      destination_directory, destination, RENAME_NOREPLACE);
#else
  return renameatx_np(source_directory, source, destination_directory,
                      destination, RENAME_EXCL);
#endif
}

static void preserve_swapped_victim(void) {
  static const char marker_name[] = "victim-preserved";
  int marker = openat(staging_directory, marker_name,
                      O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
                      0600);
  if (marker >= 0) {
    write_exact(marker, (const unsigned char *)"preserved\n", 10);
    fsync(marker);
    close(marker);
    fsync(staging_directory);
  }
  staged_file_active = 0;
  staging_active = 0;
}

static int open_existing(int directory, const char *name, struct stat *status) {
  struct stat before;
  if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) fail("NOT_FOUND", "target does not exist");
    fail("IO", "cannot inspect target");
  }
  if (S_ISLNK(before.st_mode)) fail("SYMLINK", "final component is a symlink");
  require_regular_single_link(&before);

  int fd = openat(directory, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    if (errno == ENOENT) fail("NOT_FOUND", "target does not exist");
    fail("SYMLINK", "final component changed or is inaccessible");
  }
  if (fstat(fd, status) != 0) {
    close(fd);
    fail("IO", "cannot stat target");
  }
  require_regular_single_link(status);
  if (before.st_dev != status->st_dev || before.st_ino != status->st_ino) {
    close(fd);
    fail("CAS", "target changed while opening");
  }
  return fd;
}

static void read_command(const char *path) {
  char final[MAX_COMPONENT_BYTES + 1];
  int directory = walk_parent(path, 0, 0, final);
  struct stat status;
  int fd = open_existing(directory, final, &status);
  if (status.st_size < 0 || (uint64_t)status.st_size > MAX_CONTENT_BYTES)
    fail("BOUNDS", "file is too large");
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0) fail("IO", "cannot snapshot target");

  unsigned char buffer[16384];
  for (;;) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      fail("IO", "cannot read target");
    }
    write_exact(STDOUT_FILENO, buffer, (size_t)count);
  }
  if (capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
    fail("CAS", "target changed during read");
  require_same_entry(directory, final, &status);
  close(fd);
  close(directory);
}

static int contents_equal_at_with_hook(int fd, const unsigned char *expected,
                                       size_t expected_length,
                                       const char *scan_hook) {
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0 || before.status.st_size < 0 ||
      (uint64_t)before.status.st_size != expected_length)
    return 0;
  unsigned char buffer[16384];
  size_t offset = 0;
  while (offset < expected_length) {
    size_t remaining = expected_length - offset;
    size_t requested = remaining < sizeof(buffer) ? remaining : sizeof(buffer);
    ssize_t count = pread(fd, buffer, requested, (off_t)offset);
    if (count < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (count == 0 || memcmp(buffer, expected + offset, (size_t)count) != 0)
      return 0;
    offset += (size_t)count;
  }
  unsigned char extra;
  ssize_t count;
  do count = pread(fd, &extra, 1, (off_t)offset);
  while (count < 0 && errno == EINTR);
  if (count != 0) return count < 0 ? -1 : 0;
  if (scan_hook) test_stop(scan_hook);
  if (capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
    return 0;
  return 1;
}

static int contents_equal(int fd, const unsigned char *expected,
                          size_t expected_length) {
  return contents_equal_at_with_hook(fd, expected, expected_length, NULL);
}

static int contents_equal_at(int fd, const unsigned char *expected,
                             size_t expected_length) {
  return contents_equal_at_with_hook(fd, expected, expected_length, NULL);
}

static int capture_complete_fingerprint(int fd, const unsigned char *content,
                                        size_t content_length,
                                        unsigned char **fingerprint,
                                        size_t *fingerprint_length,
                                        const char *byte_hook,
                                        const char *xattr_hook) {
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0 ||
      contents_equal_at_with_hook(fd, content, content_length, byte_hook) != 1 ||
      capture_fingerprint_with_hook(fd, fingerprint, fingerprint_length,
                                    xattr_hook) != 0 ||
      capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
    return -1;
  return 0;
}

static int capture_published_fingerprint(int fd, const unsigned char *content,
                                         size_t content_length,
                                         unsigned char **fingerprint,
                                         size_t *fingerprint_length) {
  return capture_complete_fingerprint(fd, content, content_length, fingerprint,
                                      fingerprint_length, "final-byte-scan",
                                      "final-xattr-scan");
}

static int published_matches(int fd, const unsigned char *content,
                             size_t content_length,
                             const unsigned char *fingerprint,
                             size_t fingerprint_length,
                             const char *byte_hook, const char *xattr_hook) {
  struct file_snapshot before, after;
  if (capture_snapshot(fd, &before) != 0 ||
      contents_equal_at_with_hook(fd, content, content_length, byte_hook) != 1 ||
      fingerprint_matches_with_hook(fd, fingerprint, fingerprint_length,
                                    xattr_hook) != 1 ||
      capture_snapshot(fd, &after) != 0 || !snapshots_equal(&before, &after))
    return 0;
  return 1;
}

static void require_named_bytes(int directory, const char *name,
                                const unsigned char *expected, size_t expected_length,
                                int staged, const struct stat *required_identity,
                                const struct stat *required_metadata,
                                const char *failure_code) {
  struct stat named, opened, after;
  const char *cas = failure_code ? failure_code : "CAS";
  if (fstatat(directory, name, &named, AT_SYMLINK_NOFOLLOW) != 0)
    fail(cas, staged ? "staged file disappeared" : "published target disappeared");
  if (!S_ISREG(named.st_mode))
    fail(failure_code ? failure_code : "TYPE",
         staged ? "staged file is not regular" : "published target is not regular");
  if (named.st_nlink != 1)
    fail(failure_code ? failure_code : "HARDLINK",
         staged ? "staged file link count changed" : "published target link count changed");
  int fd = openat(directory, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || fstat(fd, &opened) != 0) {
    if (fd >= 0) close(fd);
    fail(cas, staged ? "cannot reopen staged file" : "cannot reopen published target");
  }
  int equal = opened.st_dev == named.st_dev && opened.st_ino == named.st_ino &&
              (!required_identity ||
               (opened.st_dev == required_identity->st_dev &&
                opened.st_ino == required_identity->st_ino)) &&
              S_ISREG(opened.st_mode) && opened.st_nlink == 1 &&
              (!required_metadata ||
               (opened.st_uid == required_metadata->st_uid &&
                opened.st_gid == required_metadata->st_gid &&
                (opened.st_mode & 07777) == (required_metadata->st_mode & 07777))) &&
              opened.st_size >= 0 && (uint64_t)opened.st_size == expected_length &&
              contents_equal_at(fd, expected, expected_length) == 1 &&
              fstatat(directory, name, &after, AT_SYMLINK_NOFOLLOW) == 0 &&
              after.st_dev == opened.st_dev && after.st_ino == opened.st_ino &&
              S_ISREG(after.st_mode) && after.st_nlink == 1 &&
              after.st_size >= 0 && (uint64_t)after.st_size == expected_length;
  close(fd);
  if (!equal)
    fail(cas, staged ? "staged bytes changed" : "published target bytes changed");
}

static void require_named_metadata_equal(int directory, const char *name,
                                         int source) {
  int destination = openat(directory, name,
                           O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (destination < 0)
    fail("METADATA", "cannot open staged metadata for verification");
  require_equal_metadata(source, destination);
  if (close(destination) != 0)
    fail("METADATA", "cannot close staged metadata verification descriptor");
}

static void require_named_fingerprint(int directory, const char *name,
                                      const struct stat *identity,
                                      const unsigned char *content,
                                      size_t content_length,
                                      const unsigned char *fingerprint,
                                      size_t fingerprint_length) {
  int fd = openat(directory, name,
                  O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 ||
      published_matches(fd, content, content_length, fingerprint,
                        fingerprint_length, NULL, NULL) != 1 ||
      !named_identity(directory, name, identity, NULL)) {
    if (fd >= 0) close(fd);
    fail("METADATA", "staged fingerprint changed before publication");
  }
  if (close(fd) != 0)
    fail("METADATA", "cannot close staged fingerprint descriptor");
}

static int is_staging_name(const char *name, long helper_pid) {
  char prefix[64];
  int prefix_length = snprintf(prefix, sizeof(prefix), ".pi-safe-write-%ld-", helper_pid);
  if (prefix_length < 0 || (size_t)prefix_length >= sizeof(prefix) ||
      strncmp(name, prefix, (size_t)prefix_length) != 0)
    return 0;
  const char *cursor = name + prefix_length;
  if (*cursor == '0') return cursor[1] == '\0';
  if (*cursor < '1' || *cursor > '9') return 0;
  while (*cursor >= '0' && *cursor <= '9') cursor++;
  return *cursor == '\0';
}

static int cleanup_staging_directory(int parent, const char *name,
                                     const struct stat *before,
                                     const unsigned char *fingerprint,
                                     size_t fingerprint_length) {
  if (!S_ISDIR(before->st_mode) || before->st_uid != geteuid() ||
      (before->st_mode & 0077) != 0)
    return 0;
  int stage = openat(parent, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (stage < 0) return errno == ENOENT ? 0 : -1;
  struct stat opened;
  if (test_fault("PI_SAFE_WRITER_TEST_CLEANUP_FAIL", "fstat") ||
      fstat(stage, &opened) != 0) {
    close(stage);
    return -1;
  }
  if (opened.st_dev != before->st_dev || opened.st_ino != before->st_ino) {
    close(stage);
    return 0;
  }
  if (test_fault("PI_SAFE_WRITER_TEST_CLEANUP_FAIL", "fchmod") ||
      fchmod(stage, 0700) != 0 || fstat(stage, &opened) != 0 ||
      (opened.st_mode & 07777) != 0700) {
    close(stage);
    return -1;
  }

  int scan = dup(stage);
  if (scan < 0) {
    close(stage);
    return -1;
  }
  DIR *entries = fdopendir(scan);
  if (!entries) {
    close(scan);
    close(stage);
    return -1;
  }
  int has_file = 0;
  int valid = 1;
  int inspection_error = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(entries);
    if (!entry) {
      if (errno != 0) inspection_error = 1;
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (strcmp(entry->d_name, staged_file_name) != 0 || has_file) {
      valid = 0;
      continue;
    }
    struct stat file;
    if (fstatat(stage, staged_file_name, &file, AT_SYMLINK_NOFOLLOW) != 0) {
      closedir(entries);
      close(stage);
      return -1;
    }
    if (!S_ISREG(file.st_mode) || file.st_nlink != 1) {
      valid = 0;
      continue;
    }
    has_file = 1;
  }
  if (closedir(entries) != 0) inspection_error = 1;
  if (inspection_error) {
    close(stage);
    return -1;
  }
  if (valid && has_file) {
    int file = openat(stage, staged_file_name,
                      O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    valid = file >= 0 &&
            fingerprint_matches(file, fingerprint, fingerprint_length) == 1;
    if (file >= 0) close(file);
  }
  if (!valid) {
    int close_error = close(stage);
    return close_error == 0 ? 0 : -1;
  }
  if (has_file && unlinkat(stage, staged_file_name, 0) != 0 && errno != ENOENT) {
    close(stage);
    return -1;
  }
  if (close(stage) != 0) return -1;
  if (unlinkat(parent, name, AT_REMOVEDIR) != 0 && errno != ENOENT) return -1;
  return 1;
}

static void cleanup_stale_staging(int directory, long helper_pid,
                                  const unsigned char *fingerprint,
                                  size_t fingerprint_length) {
  int scan = dup(directory);
  if (scan < 0) fail("AMBIGUOUS", "cannot scan target parent for stale staging directories");
  DIR *entries = fdopendir(scan);
  if (!entries) {
    close(scan);
    fail("AMBIGUOUS", "cannot scan target parent for stale staging directories");
  }
  int removed = 0;
  int scan_error = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(entries);
    if (!entry) {
      scan_error = errno;
      break;
    }
    if (!is_staging_name(entry->d_name, helper_pid)) continue;
    struct stat status;
    if (fstatat(directory, entry->d_name, &status, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) continue;
      closedir(entries);
      fail("AMBIGUOUS", "cannot inspect stale staging directory");
    }
    int result = cleanup_staging_directory(directory, entry->d_name, &status,
                                           fingerprint, fingerprint_length);
    if (result < 0) {
      closedir(entries);
      fail("AMBIGUOUS", "cannot remove stale staging directory");
    }
    if (result > 0) removed = 1;
  }
  if (closedir(entries) != 0 || scan_error != 0)
    fail("AMBIGUOUS", "cannot finish stale staging scan");
  if (removed && fsync(directory) != 0)
    fail("AMBIGUOUS", "cannot sync stale staging cleanup");
}

static int namespace_identity(int directory, const char *name,
                              const struct stat *expected) {
  struct stat current;
  return fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0 &&
         same_identity(&current, expected) &&
         (current.st_mode & S_IFMT) == (expected->st_mode & S_IFMT);
}

static int displaced_matches(int directory, const char *target,
                             const struct stat *staged_identity,
                             const struct stat *old_identity,
                             uint64_t old_flags,
                             const unsigned char *expected, size_t expected_length,
                             const unsigned char *content, size_t content_length) {
  struct stat displaced_named, displaced_opened, target_opened;
  struct file_snapshot displaced_before, displaced_after;
  struct file_snapshot published_before, published_after;
  if (!named_identity(staging_directory, staged_file_name, old_identity,
                      &displaced_named) ||
      !named_identity(directory, target, staged_identity, NULL))
    return 0;
  int displaced = openat(staging_directory, staged_file_name,
                         O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  int published = openat(directory, target,
                         O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  uint64_t displaced_flags;
  int equal = displaced >= 0 && published >= 0 &&
              capture_snapshot(displaced, &displaced_before) == 0 &&
              capture_snapshot(published, &published_before) == 0 &&
              fstat(displaced, &displaced_opened) == 0 &&
              fstat(published, &target_opened) == 0 &&
              same_identity(&displaced_opened, old_identity) &&
              same_identity(&target_opened, staged_identity) &&
              S_ISREG(displaced_opened.st_mode) && displaced_opened.st_nlink == 1 &&
              displaced_opened.st_uid == old_identity->st_uid &&
              displaced_opened.st_gid == old_identity->st_gid &&
              (displaced_opened.st_mode & 07777) == (old_identity->st_mode & 07777) &&
              target_opened.st_uid == old_identity->st_uid &&
              target_opened.st_gid == old_identity->st_gid &&
              (target_opened.st_mode & 07777) == (old_identity->st_mode & 07777) &&
              contents_equal_at(displaced, expected, expected_length) == 1 &&
              contents_equal_at(published, content, content_length) == 1 &&
              load_file_flags(displaced, &displaced_flags) == 0 &&
              displaced_flags == old_flags &&
              target_has_relevant_flags(published) == 0 &&
              acl_state(displaced) == 0 && acl_state(published) == 0 &&
              xattrs_equal(displaced, published) == 1 &&
              capture_snapshot(displaced, &displaced_after) == 0 &&
              capture_snapshot(published, &published_after) == 0 &&
              snapshots_equal(&displaced_before, &displaced_after) &&
              snapshots_equal(&published_before, &published_after) &&
              namespace_identity(staging_directory, staged_file_name,
                                 &displaced_named) &&
              namespace_identity(directory, target, &target_opened);
  if (displaced >= 0) close(displaced);
  if (published >= 0) close(published);
  return equal;
}

enum observed_target { TARGET_ABSENT, TARGET_EXPECTED, TARGET_CONTENT, TARGET_OTHER };

static enum observed_target classify_target(int directory, const char *name,
                                             const unsigned char *expected, size_t expected_length,
                                             const unsigned char *content, size_t content_length,
                                             const unsigned char *staged_fingerprint,
                                             size_t staged_fingerprint_length,
                                             const unsigned char *fingerprint,
                                             size_t fingerprint_length,
                                             struct stat *observed_identity) {
  struct stat before;
  if (fstatat(directory, name, &before, AT_SYMLINK_NOFOLLOW) != 0)
    return errno == ENOENT ? TARGET_ABSENT : TARGET_OTHER;
  if (!S_ISREG(before.st_mode) || before.st_nlink != 1) return TARGET_OTHER;

  int fd = openat(directory, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return TARGET_OTHER;
  struct stat opened, after;
  struct file_snapshot scan_before, scan_after;
  if (fstat(fd, &opened) != 0 || !S_ISREG(opened.st_mode) || opened.st_nlink != 1 ||
      opened.st_dev != before.st_dev || opened.st_ino != before.st_ino ||
      capture_snapshot(fd, &scan_before) != 0) {
    close(fd);
    return TARGET_OTHER;
  }
  int bytes_are_content =
      contents_equal_at(fd, content, content_length) == 1;
  int staged_was_published =
      fingerprint_identity_matches(fd, staged_fingerprint,
                                   staged_fingerprint_length);
  int is_content = fingerprint_length > 0 && bytes_are_content &&
                   published_matches(fd, content, content_length, fingerprint,
                                     fingerprint_length, NULL, NULL);
  int is_expected = !fingerprint_length && !staged_was_published &&
                    contents_equal_at(fd, expected, expected_length) == 1;
  int unchanged = capture_snapshot(fd, &scan_after) == 0 &&
                  snapshots_equal(&scan_before, &scan_after) &&
                  fstatat(directory, name, &after, AT_SYMLINK_NOFOLLOW) == 0 &&
                  after.st_dev == opened.st_dev && after.st_ino == opened.st_ino;
  close(fd);
  if (!unchanged) return TARGET_OTHER;
  if (is_content) {
    *observed_identity = opened;
    return TARGET_CONTENT;
  }
  if (fingerprint_length && bytes_are_content) return TARGET_OTHER;
  if (is_expected) return TARGET_EXPECTED;
  return TARGET_OTHER;
}

static int make_stage(int parent) {
  static unsigned counter = 0;
  sigset_t blocked, previous;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGTERM);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous) != 0)
    fail("SIGNAL", "cannot protect staging allocation");

  staging_parent = parent;
  for (unsigned attempt = 0; attempt < 128; attempt++) {
    (void)attempt;
    snprintf(staging_name, sizeof(staging_name), ".pi-safe-write-%ld-%u", (long)getpid(), counter++);
    if (mkdirat(parent, staging_name, 0700) != 0) {
      if (errno == EEXIST) continue;
      fail("IO", "cannot create staging directory");
    }
    staging_active = 1;
    struct stat named, opened;
    if (fstatat(parent, staging_name, &named, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISDIR(named.st_mode) || named.st_uid != geteuid() ||
        (named.st_mode & 0077) != 0)
      fail("IO", "cannot verify private staging directory");
    staging_directory = openat(parent, staging_name,
                               O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (staging_directory < 0 || fstat(staging_directory, &opened) != 0 ||
        opened.st_dev != named.st_dev || opened.st_ino != named.st_ino ||
        fchmod(staging_directory, 0700) != 0 ||
        fstat(staging_directory, &opened) != 0 || (opened.st_mode & 07777) != 0700)
      fail("IO", "cannot open and normalize staging directory");
    if (clear_and_verify_acl(staging_directory, "directory") != 0)
      fail("ACL", "cannot clear or verify staging directory ACL");
    int fd = openat(staging_directory, staged_file_name,
                    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) fail("IO", "cannot create staged file");
    staged_file_active = 1;
    if (clear_and_verify_acl(fd, "file") != 0)
      fail("ACL", "cannot clear or verify staged file ACL");
    if (sigprocmask(SIG_SETMASK, &previous, NULL) != 0)
      fail("SIGNAL", "cannot finish staging allocation");
    return fd;
  }
  fail("IO", "cannot allocate staging directory name");
  return -1;
}

#ifdef PI_SAFE_WRITER_TESTING
static void test_stop(const char *stage) {
  const char *requested = getenv("PI_SAFE_WRITER_TEST_STOP");
  if (!requested || strcmp(requested, stage) != 0) return;
  write_exact(4, (const unsigned char *)stage, strlen(stage));
  raise(SIGSTOP);
}
#else
static void test_stop(const char *stage) { (void)stage; }
#endif

static void mutation_command(const char *operation, const char *path, const char *expected_arg,
                             const char *content_arg) {
  int replacing = strcmp(operation, "replace") == 0;
  int creating = strcmp(operation, "create") == 0;
  if (!replacing && !creating) fail("PROTOCOL", "unknown operation");

  uint64_t expected_length = parse_length(expected_arg);
  uint64_t content_length = parse_length(content_arg);
  if (creating && expected_length != 0) fail("PROTOCOL", "create cannot include expected bytes");

  unsigned char *expected = malloc((size_t)(expected_length ? expected_length : 1));
  unsigned char *content = malloc((size_t)(content_length ? content_length : 1));
  if (!expected || !content) fail("IO", "allocation failed");
  read_exact(STDIN_FILENO, expected, (size_t)expected_length);
  read_exact(STDIN_FILENO, content, (size_t)content_length);
  unsigned char extra;
  ssize_t extra_count;
  do extra_count = read(STDIN_FILENO, &extra, 1); while (extra_count < 0 && errno == EINTR);
  if (extra_count != 0) fail("PROTOCOL", "trailing input");

  int lock = acquire_root_lock();
  char final[MAX_COMPONENT_BYTES + 1];
  int directory = walk_parent(path, creating, 0, final);
  struct stat opened_status, staged_status;
  int existing = -1;
  uint64_t opened_flags = 0;
  mode_t mode;
  uid_t uid = geteuid();
  gid_t gid = getegid();

  if (replacing) {
    existing = open_existing(directory, final, &opened_status);
    if (!contents_equal(existing, expected, (size_t)expected_length))
      fail("CAS", "target bytes changed");
    test_add_xattr(existing, "initial");
    require_replace_metadata(existing, &opened_status);
    if (load_file_flags(existing, &opened_flags) != 0)
      fail("METADATA", "cannot inspect target file flags");
    mode = opened_status.st_mode & 07777;
    uid = opened_status.st_uid;
    gid = opened_status.st_gid;
  } else {
    struct stat target;
    if (fstatat(directory, final, &target, AT_SYMLINK_NOFOLLOW) == 0)
      fail(S_ISLNK(target.st_mode) ? "SYMLINK" : "CAS", "expected target to be absent");
    if (errno != ENOENT) fail("IO", "cannot inspect target");
    mode_t mask = umask(0);
    umask(mask);
    mode = 0666 & ~mask;
  }

  int staged = make_stage(directory);
  test_stop("writing");
  write_exact(staged, content, (size_t)content_length);
  if (fchown(staged, uid, gid) != 0 || fchmod(staged, mode & 07777) != 0)
    fail("METADATA", "cannot preserve target ownership or mode");
  if (clear_and_verify_acl(staged, "final-file") != 0)
    fail("ACL", "cannot clear or verify final staged file ACL");
  if (replacing && copy_xattrs(existing, staged) != 0)
    fail("METADATA", "cannot copy and verify target security metadata");
  if (replacing) require_equal_metadata(existing, staged);
  if (fsync(staged) != 0 || close(staged) != 0)
    fail("IO", "cannot sync staged file");

  int staged_check = openat(staging_directory, staged_file_name,
                            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  unsigned char *fingerprint = NULL;
  size_t fingerprint_length = 0;
  if (staged_check < 0 || fstat(staged_check, &staged_status) != 0 ||
      capture_complete_fingerprint(staged_check, content,
                                   (size_t)content_length, &fingerprint,
                                   &fingerprint_length, NULL, NULL) != 0)
    fail("METADATA", "cannot capture complete staged fingerprint");
  close(staged_check);
  write_receipt_record(RECEIPT_STAGED, fingerprint, fingerprint_length);

  test_stop("precommit");
  sigset_t blocked, previous;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGTERM);
  if (sigprocmask(SIG_BLOCK, &blocked, &previous) != 0)
    fail("SIGNAL", "cannot enter commit region");

  if (replacing) {
    require_same_entry(directory, final, &opened_status);
    test_add_xattr(existing, "precommit");
    require_replace_metadata(existing, &opened_status);
    if (contents_equal_at(existing, expected, (size_t)expected_length) != 1)
      fail("CAS", "target bytes changed before publication");
    require_named_bytes(staging_directory, staged_file_name, content,
                        (size_t)content_length, 1, &staged_status,
                        &opened_status, NULL);
    require_named_metadata_equal(staging_directory, staged_file_name, existing);
    require_named_fingerprint(staging_directory, staged_file_name,
                              &staged_status, content, (size_t)content_length,
                              fingerprint, fingerprint_length);
    test_stop("prepublish");
    if (atomic_exchange(staging_directory, staged_file_name,
                        directory, final) != 0)
      fail((errno == ENOSYS || errno == ENOTSUP || errno == EOPNOTSUPP || errno == EINVAL)
               ? "UNAVAILABLE" : "CAS",
           "atomic namespace exchange failed");
    namespace_published = 1;
    staged_file_active = 0;
    struct stat displaced_status;
    int displaced_observed =
        fstatat(staging_directory, staged_file_name, &displaced_status,
                AT_SYMLINK_NOFOLLOW) == 0;
    test_stop("postexchange");
    if (!displaced_observed ||
        !displaced_matches(directory, final, &staged_status,
                           &opened_status, opened_flags, expected,
                           (size_t)expected_length, content,
                           (size_t)content_length)) {
      int can_rollback = displaced_observed &&
                         namespace_identity(directory, final, &staged_status) &&
                         namespace_identity(staging_directory, staged_file_name,
                                            &displaced_status);
      if (can_rollback &&
          !test_fault("PI_SAFE_WRITER_TEST_ROLLBACK_FAIL", "exchange") &&
          atomic_exchange(staging_directory, staged_file_name,
                          directory, final) == 0 &&
          namespace_identity(directory, final, &displaced_status) &&
          namespace_identity(staging_directory, staged_file_name,
                             &staged_status)) {
        staged_file_active = 1;
        if (fsync(directory) == 0) {
          namespace_published = 0;
          fail("CAS", "target changed before atomic exchange");
        }
      }
      preserve_swapped_victim();
      fail("AMBIGUOUS", "cannot safely roll back exchanged target");
    }
    if (!namespace_identity(directory, final, &staged_status) ||
        !namespace_identity(staging_directory, staged_file_name,
                            &opened_status)) {
      preserve_swapped_victim();
      fail("AMBIGUOUS", "exchange namespaces changed before cleanup");
    }
    if (unlinkat(staging_directory, staged_file_name, 0) != 0)
      fail("IO", "cannot remove displaced old target");
  } else {
    struct stat target;
    if (fstatat(directory, final, &target, AT_SYMLINK_NOFOLLOW) == 0)
      fail(S_ISLNK(target.st_mode) ? "SYMLINK" : "CAS", "target appeared");
    if (errno != ENOENT) fail("IO", "cannot inspect target before publication");
    require_named_bytes(staging_directory, staged_file_name, content,
                        (size_t)content_length, 1, &staged_status, NULL, NULL);
    require_named_fingerprint(staging_directory, staged_file_name,
                              &staged_status, content, (size_t)content_length,
                              fingerprint, fingerprint_length);
    test_stop("prepublish");
    if (atomic_noreplace(staging_directory, staged_file_name,
                         directory, final) != 0) {
      int publication_error = errno;
      if (publication_error == EEXIST) {
        struct stat raced;
        fail(fstatat(directory, final, &raced, AT_SYMLINK_NOFOLLOW) == 0 &&
                     S_ISLNK(raced.st_mode) ? "SYMLINK" : "CAS",
             "target appeared during atomic create");
      }
      fail((publication_error == ENOSYS || publication_error == ENOTSUP ||
            publication_error == EOPNOTSUPP || publication_error == EINVAL)
               ? "UNAVAILABLE" : "CAS",
           "atomic no-replace create failed");
    }
    namespace_published = 1;
    staged_file_active = 0;
  }
  if (test_fault("PI_SAFE_WRITER_TEST_POST_PUBLISH_FAIL", "close-stage"))
    fail("IO", "cannot close staging directory");
  if (close(staging_directory) != 0) {
    staging_directory = -1;
    fail("IO", "cannot close staging directory");
  }
  staging_directory = -1;
  if (test_fault("PI_SAFE_WRITER_TEST_POST_PUBLISH_FAIL", "unlink-stage") ||
      unlinkat(directory, staging_name, AT_REMOVEDIR) != 0)
    fail("IO", "cannot remove staging directory");
  staging_active = 0;

  int parent_sync_failed =
      test_fault("PI_SAFE_WRITER_TEST_MUTATION_FSYNC_FAIL", "1") ||
      fsync(directory) != 0;
  require_named_bytes(directory, final, content, (size_t)content_length, 0,
                      &staged_status, NULL, NULL);
  int published = openat(directory, final,
                         O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  unsigned char *published_fingerprint = NULL;
  size_t published_fingerprint_length = 0;
  if (published < 0 ||
      capture_published_fingerprint(published, content,
                                    (size_t)content_length,
                                    &published_fingerprint,
                                    &published_fingerprint_length) != 0 ||
      !namespace_identity(directory, final, &staged_status)) {
    if (published >= 0) close(published);
    fail("METADATA", "cannot capture stable published fingerprint");
  }
  write_receipt_record(RECEIPT_PUBLISHED, published_fingerprint,
                       published_fingerprint_length);
  if (parent_sync_failed) fail("IO", "cannot sync parent directory");
  test_stop("postrename");
  if (!published_matches(published, content, (size_t)content_length,
                         published_fingerprint, published_fingerprint_length,
                         NULL, NULL) ||
      !namespace_identity(directory, final, &staged_status)) {
    close(published);
    fail("METADATA", "published fingerprint changed");
  }
  close(published);
  committed = 1;
  test_stop("postcommit");
  if (test_fault("PI_SAFE_WRITER_TEST_POST_PUBLISH_FAIL", "signal-mask") ||
      sigprocmask(SIG_SETMASK, &previous, NULL) != 0)
    fail("SIGNAL", "cannot leave commit region");

  if (existing >= 0) close(existing);
  close(directory);
  close(lock);
  free(published_fingerprint);
  free(fingerprint);
  free(expected);
  free(content);
}

static void reconcile_command(const char *operation, const char *path,
                              const char *expected_arg, const char *content_arg,
                              const char *fingerprint_arg, const char *pid_arg) {
  int replacing = strcmp(operation, "reconcile-replace") == 0;
  int creating = strcmp(operation, "reconcile-create") == 0;
  if (!replacing && !creating) fail("PROTOCOL", "unknown reconciliation operation");

  long helper_pid = parse_pid(pid_arg);
  uint64_t expected_length = parse_length(expected_arg);
  uint64_t content_length = parse_length(content_arg);
  uint64_t receipt_length = parse_length(fingerprint_arg);
  if (creating && expected_length != 0)
    fail("PROTOCOL", "create reconciliation cannot include expected bytes");
  if (receipt_length > MAX_RECEIPT_BYTES)
    fail("PROTOCOL", "reconciliation receipt is too large");
  unsigned char *expected = malloc((size_t)(expected_length ? expected_length : 1));
  unsigned char *content = malloc((size_t)(content_length ? content_length : 1));
  unsigned char *receipt = malloc((size_t)(receipt_length ? receipt_length : 1));
  if (!expected || !content || !receipt)
    fail("AMBIGUOUS", "reconciliation allocation failed");
  read_exact(STDIN_FILENO, expected, (size_t)expected_length);
  read_exact(STDIN_FILENO, content, (size_t)content_length);
  read_exact(STDIN_FILENO, receipt, (size_t)receipt_length);
  unsigned char extra;
  ssize_t extra_count;
  do extra_count = read(STDIN_FILENO, &extra, 1); while (extra_count < 0 && errno == EINTR);
  if (extra_count != 0) fail("PROTOCOL", "trailing reconciliation input");
  struct receipt_fingerprints fingerprints;
  if (parse_receipt(receipt, (size_t)receipt_length, &fingerprints) != 0)
    fail("AMBIGUOUS", "native publication receipt is incomplete or invalid");

  int lock = acquire_root_lock();
  char final[MAX_COMPONENT_BYTES + 1];
  int directory = walk_parent(path, 0, 1, final);
  enum observed_target observed = TARGET_ABSENT;
  struct stat observed_identity;
  if (directory >= 0) {
    cleanup_stale_staging(directory, helper_pid, fingerprints.staged,
                          fingerprints.staged_length);
    observed = classify_target(directory, final, expected, (size_t)expected_length,
                               content, (size_t)content_length,
                               fingerprints.staged,
                               fingerprints.staged_length,
                               fingerprints.published,
                               fingerprints.published_length,
                               &observed_identity);
    if (observed == TARGET_CONTENT) {
      test_stop("reconcile-post-classification");
#ifdef PI_SAFE_WRITER_TESTING
      if (getenv("PI_SAFE_WRITER_TEST_RECONCILE_FSYNC_FAIL")) {
        close(directory);
        fail("AMBIGUOUS", "cannot sync reconciled target parent");
      }
#endif
      if (fsync(directory) != 0) {
        close(directory);
        fail("AMBIGUOUS", "cannot sync reconciled target parent");
      }
      test_stop("reconcile-post-fsync");
      int verified = openat(directory, final,
                            O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
      if (verified < 0 ||
          !published_matches(verified, content, (size_t)content_length,
                             fingerprints.published,
                             fingerprints.published_length,
                             "reconcile-final-byte-scan",
                             "reconcile-final-xattr-scan") ||
          !namespace_identity(directory, final, &observed_identity)) {
        if (verified >= 0) close(verified);
        fail("AMBIGUOUS", "reconciled target fingerprint changed");
      }
      close(verified);
      write_exact(STDOUT_FILENO, (const unsigned char *)"SUCCESS\n", 8);
      close(directory);
      close(lock);
      free(expected);
      free(content);
      free(receipt);
      return;
    }
    close(directory);
  }
  close(lock);
  free(expected);
  free(content);
  free(receipt);

  if ((replacing && observed == TARGET_EXPECTED) || (creating && observed == TARGET_ABSENT)) {
    write_exact(STDOUT_FILENO, (const unsigned char *)"ABORTED\n", 8);
    return;
  }
  fail("AMBIGUOUS", "target differs from both pre-mutation and requested bytes");
}

int main(int argc, char **argv) {
  install_signal_handler();
  if (argc < 3) fail("PROTOCOL", "usage: safe-writer read PATH | replace/create PATH EXPECTED_LEN CONTENT_LEN");
  if (strcmp(argv[1], "read") == 0) {
    if (argc != 3) fail("PROTOCOL", "invalid read arguments");
    read_command(argv[2]);
    return 0;
  }
  if (strncmp(argv[1], "reconcile-", 10) == 0) {
    if (argc != 7) fail("PROTOCOL", "invalid reconciliation arguments");
    reconcile_command(argv[1], argv[2], argv[3], argv[4], argv[5], argv[6]);
  } else {
    if (argc != 5) fail("PROTOCOL", "invalid mutation arguments");
    mutation_command(argv[1], argv[2], argv[3], argv[4]);
  }
  return 0;
}
