# Changelog

## 0.1.0

Initial extraction from Trebol `e09781a`.

- Preserved history for TaskManage core, its 13 test suites, the Pi wrapper, the task browser, the Hoja filing layer and their `.pi/lib` dependencies.
- Added `src/extension/index.ts` composing TaskManage + task browser + Hoja filing as one Pi extension.
- Added build/test configuration: `tsc` over `packages/**/src`, `vitest` over all suites.
