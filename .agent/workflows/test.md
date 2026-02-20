---
description: Run unit or E2E tests for Vendure packages
---

# Test

// turbo-all

1. Run ALL unit tests:
```bash
npm run test
```

2. Run unit tests for a specific package:
```bash
cd packages/<package-name> && npm run test
```

3. Run ALL E2E tests:
```bash
npm run e2e
```

4. Run a specific E2E test:
```bash
cd packages/<package-name> && npm run e2e <test-file>
```

5. Reset E2E cache (required after schema changes):
```bash
rm -rf packages/<package-name>/e2e/__data__
```
