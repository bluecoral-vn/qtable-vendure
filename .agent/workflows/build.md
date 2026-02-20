---
description: Build one or all Vendure packages
---

# Build

// turbo-all

1. To build ALL packages:
```bash
npm run build
```

2. To build only core + common (most common during dev):
```bash
npm run build:core-common
```

3. To build a specific package:
```bash
cd packages/<package-name> && npm run build
```

4. To watch core + common for changes:
```bash
npm run watch:core-common
```
