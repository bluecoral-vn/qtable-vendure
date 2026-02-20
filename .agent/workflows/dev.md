---
description: Start Vendure dev server with MariaDB
---

# Dev Server

// turbo-all

1. Ensure MariaDB is running:
```bash
docker-compose up -d mariadb
```

2. Build core and common (if not built):
```bash
npm run build:core-common
```

3. Start dev server:
```bash
cd packages/dev-server && npm run dev
```

4. Dev server will be available at:
- Admin API: http://localhost:3000/admin-api
- Shop API: http://localhost:3000/shop-api
- Admin UI: http://localhost:5001/admin
- Dashboard: http://localhost:5001/dashboard
