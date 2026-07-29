# pi-tools migration

`vendor/pi-tools` is ordinary root-tracked source copied from the required modified working tree of [`davis7dotsh/my-pi-setup`](https://github.com/davis7dotsh/my-pi-setup) at `d8534d7e6ec6609b7e684a8a0eb2e7a0195115ba`.

License status is user-confirmed MIT. Source attribution is retained in [`vendor/pi-tools/UPSTREAM.md`](../vendor/pi-tools/UPSTREAM.md).

The directory preserves current extensions, skills, theme, tests, and setup dependencies. Excluded artifacts: `.git`, every `node_modules`, generated caches/build output, and generated `extensions/subagents/native/bin/pi-safe-writer`; setup rebuilds that binary.

Fresh clones need only initialize `vendor/pi-caveman`; `npm run setup:ben` installs pi-tools and its loaded extension dependencies without any my-pi-setup submodule initialization.
