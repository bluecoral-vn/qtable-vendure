---
description: Sync fork with upstream Vendure repository
---

# Sync Upstream

1. Fetch upstream changes:
```bash
git fetch upstream
```

2. Check upstream version:
```bash
git log upstream/master --oneline -5
```

3. Merge upstream into local master:
```bash
git merge upstream/master
```

4. If merge conflicts in `packages/`:
> **IMPORTANT:** Always accept upstream for files in `packages/`.
> Custom logic should ONLY be in plugins, not in upstream packages.

```bash
git checkout --theirs packages/<conflicting-file>
git add packages/<conflicting-file>
git merge --continue
```

5. Rebuild after sync:
```bash
npm install
npm run build
```

6. Run tests to verify:
```bash
npm run test
```
