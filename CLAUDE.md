# CLAUDE.md - LazarilloApp-Backend

This document provides essential context for AI assistants working on the LazarilloApp-Backend codebase.

## Project Overview

**LazarilloApp-Backend** is a Node.js/Express multi-tenant SaaS platform for restaurant and retail business management in Argentina. It integrates with **Maxi Sistemas** (a popular Argentine POS/ERP system) to automatically sync product catalogs, track sales, manage inventory, and provide business analytics.

**Core Value Proposition**: Businesses using Maxi Sistemas can connect their POS data to gain automated sales insights, inventory management, and product grouping capabilities without manual data entry.

## Technology Stack

- **Runtime**: Node.js 18+ with CommonJS modules
- **Framework**: Express 5.x
- **Database**: PostgreSQL 13+ (raw SQL with pg driver, minimal ORM)
- **Authentication**: JWT (7-day expiration) with bcrypt password hashing
- **Encryption**: AES-256-GCM for sensitive credentials
- **Scheduling**: node-cron for daily background tasks
- **External API**: Axios for Maxi Sistemas integration

**Key Dependencies**:
```json
{
  "express": "^5.1.0",
  "pg": "^8.16.3",
  "jsonwebtoken": "^9.0.2",
  "bcrypt": "^6.0.0",
  "axios": "^1.11.0",
  "node-cron": "^4.2.1"
}
```

## Architecture Overview

### Directory Structure

```
/home/user/LazarilloApp-Backend/
├── app.js                    # Main entry point (Express app setup)
├── config/
│   └── db.js                 # PostgreSQL connection pool
├── controllers/              # Business logic handlers (18+ files)
├── routes/                   # API route definitions
├── services/                 # Core business logic (Maxi integration, sync)
├── middleware/               # Auth, CORS, business context loading
├── models/                   # Limited use (mostly raw SQL)
├── repos/                    # Data access repositories
├── db/
│   ├── migrations.js         # Migration orchestrator (runs on startup)
│   └── migrations/live/      # SQL + JS migrations
└── utils/                    # Encryption, email, caching, retry logic
```

### Key Architectural Patterns

1. **Multi-tenancy**: All data is scoped by `business_id` with FK constraints
2. **Raw SQL over ORM**: Direct PostgreSQL queries for performance and clarity
3. **Idempotent operations**: Upserts with `ON CONFLICT` for safe retries
4. **Service layer pattern**: Controllers delegate to services for business logic
5. **Middleware chain**: Auth → Business context → Role checks → Controller
6. **Advisory locks**: Prevent concurrent operations per business

## Core Concepts

### Multi-Tenancy Model

Every request must be scoped to a business. Business context is resolved in this order:

1. `X-Business-Id` HTTP header (preferred)
2. `?businessId` query parameter
3. `:businessId` or `:id` route parameter
4. User's `active_business_id` (fallback for real users)

**Membership validation**: User must be owner or member via `user_businesses` table.

**Service tokens**: Bypass membership checks (existence check only) using `SERVICE_BEARER` env var.

### Database Schema Highlights

#### Core Tables
- `app_users` - User accounts (email, password_hash, role)
- `app_businesses` - Tenant data (name, owner_id, props JSONB)
- `user_businesses` - Membership mapping (many-to-many)
- `app_articles` - Products from Maxi (with taxonomy FKs)
- `app_sales` + `app_sales_items` - Transaction data
- `sales_daily` + `sales_daily_items` - Pre-aggregated daily summaries
- `sales_sync_state` - Tracks sync progress per business
- `agrupaciones` - Custom product groupings
- `maxi_*` tables - Raw Maxi API data cache

#### Critical Indexes
```sql
-- Performance-critical indexes
CREATE INDEX idx_sales_business_occurred ON app_sales(business_id, occurred_at);
CREATE INDEX idx_sales_items_article ON app_sales_items(article_id);
CREATE INDEX idx_sales_daily_business_day ON sales_daily(business_id, day);
CREATE INDEX idx_articles_business ON app_articles(business_id);
```

### Maxi Sistemas Integration

**Maxi** is an Argentine cloud POS/ERP system. Integration credentials are stored per-business in `app_businesses.props.maxi`:

```json
{
  "email": "user@business.com",
  "codcli": "12345",
  "pass_enc": "{\"v\":1,\"iv\":\"...\",\"tag\":\"...\",\"ct\":\"...\"}"
}
```

**Key Services**:
- `maxiSalesService.js` - Fetch sales via `/estadisticas/fullinvoicebydate`
- `maxiMenuService.js` - Fetch catalog via `/menuweb/menuextendido`
- `maxiSuppliesService.js` - Fetch supplies/ingredients
- `maxiCredsService.js` - Manage encrypted credentials

**Authentication Flow**:
1. Decrypt password from `props.maxi.pass_enc`
2. POST to `/login` with {email, pass, cod_cli}
3. Extract `tokenAccess` from response
4. Cache token for 9 minutes (avoids re-auth on every request)
5. Include in subsequent requests as `Authorization: Bearer <token>`

**Error Handling**:
- Token expiration → Auto re-authenticate
- Rate limiting (429) → Exponential backoff
- Server errors (5xx) → Retry with smaller windows
- Network errors → Up to 3 retries

## Development Workflows

### Adding a New API Endpoint

1. **Create route**: Add to `/routes/<domain>Routes.js`
   ```javascript
   router.get('/new-endpoint', authRequired, loadActiveBusiness, controller.handler);
   ```

2. **Create controller**: Add handler to `/controllers/<domain>Controller.js`
   ```javascript
   async function handler(req, res) {
     const {businessId, user} = req;
     // Business logic or delegate to service
     res.json({data});
   }
   ```

3. **Add service logic** (if complex): Create/update `/services/<domain>Service.js`

4. **Test**: Use Postman/curl with JWT token and `X-Business-Id` header

### Database Migrations

**Location**: `/db/migrations/live/`

**Naming**: `NNN_description.sql` or `NNN_description.js` (alphabetically sorted)

**Pattern** (SQL):
```sql
-- Always idempotent
CREATE TABLE IF NOT EXISTS my_table (
  id SERIAL PRIMARY KEY,
  business_id INT NOT NULL REFERENCES app_businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_my_table_business ON my_table(business_id);
```

**Pattern** (JS):
```javascript
module.exports = async function(pool) {
  await pool.query(`
    ALTER TABLE my_table
    ADD COLUMN IF NOT EXISTS new_column TEXT;
  `);
};
```

**Execution**: Migrations run automatically on app startup via `db/migrations.js`.

### Adding Maxi Integration Features

1. **Identify Maxi endpoint**: Check Maxi API docs or existing `maxiXxxService.js` files
2. **Add to service**: Create or extend service in `/services/`
3. **Handle authentication**: Use `getOrRefreshMaxiToken(businessId)`
4. **Parse response**: Maxi responses are `{resultCode, content}` format
5. **Cache if needed**: Use `maxi_*_cache` tables for expensive operations
6. **Update sync logic**: If data syncs daily, add to `services/cron.js`

### Common CRUD Pattern

```javascript
// Controller
async function listItems(req, res) {
  const {businessId} = req;
  const {rows} = await pool.query(`
    SELECT * FROM items WHERE business_id = $1 ORDER BY created_at DESC
  `, [businessId]);
  res.json({items: rows});
}

async function createItem(req, res) {
  const {businessId} = req;
  const {name} = req.body;
  const {rows} = await pool.query(`
    INSERT INTO items (business_id, name) VALUES ($1, $2) RETURNING *
  `, [businessId, name]);
  res.status(201).json({item: rows[0]});
}

async function updateItem(req, res) {
  const {businessId} = req;
  const {id} = req.params;
  const {name} = req.body;
  const {rows} = await pool.query(`
    UPDATE items SET name = $1, updated_at = NOW()
    WHERE id = $2 AND business_id = $3
    RETURNING *
  `, [name, id, businessId]);
  if (rows.length === 0) return res.status(404).json({error: 'not_found'});
  res.json({item: rows[0]});
}

async function deleteItem(req, res) {
  const {businessId} = req;
  const {id} = req.params;
  await pool.query(`
    DELETE FROM items WHERE id = $1 AND business_id = $2
  `, [id, businessId]);
  res.status(204).send();
}
```

## Key Conventions

### Code Style

1. **Async/await**: Always use async/await (no callbacks)
2. **Error handling**: Try/catch in controllers, return 500 with logged error
   ```javascript
   try {
     // logic
   } catch (err) {
     console.error('Error in handler:', err);
     res.status(500).json({error: 'internal', message: err.message});
   }
   ```
3. **SQL parameterization**: Always use `$1, $2, ...` placeholders (never string interpolation)
4. **Destructuring**: Use `const {rows} = await pool.query(...)` pattern
5. **Date handling**: Work in UTC, use `Date.UTC()` for date construction
6. **Naming**: camelCase for JS, snake_case for SQL

### Security Practices

1. **Never expose encrypted data**: Strip `pass_enc` before sending to client
2. **Validate business access**: Always check business_id matches user's membership
3. **Use parameterized queries**: Prevents SQL injection
4. **Hash sensitive logs**: Redact `Authorization` headers in logs
5. **Advisory locks**: Use for critical sections (syncs, aggregations)
   ```javascript
   const lockId = 0x53A1E5 ^ businessId;
   const {rows} = await pool.query('SELECT pg_try_advisory_lock($1)', [lockId]);
   if (!rows[0].pg_try_advisory_lock) {
     return res.status(409).json({error: 'sync_in_progress'});
   }
   // ... do work ...
   await pool.query('SELECT pg_advisory_unlock($1)', [lockId]);
   ```

### API Response Formats

**Success**:
```json
{
  "data": {...},
  "items": [...],
  "ok": true,
  "message": "Optional success message"
}
```

**Error**:
```json
{
  "error": "error_code",
  "message": "Human-readable error message"
}
```

**Common error codes**:
- `missing_token` (401)
- `unauthorized` (401)
- `forbidden` (403)
- `not_found` (404)
- `validation_error` (400)
- `internal` (500)

### Date and Time Handling

**CRITICAL**: Always work in UTC to avoid timezone bugs.

```javascript
// Parse date to UTC midnight
function parseToUTC(dateStr) {
  const d = new Date(dateStr);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Get yesterday at 00:00 UTC (for sync boundaries)
function getYesterdayUTC() {
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday;
}

// Format for Maxi API (YYYY-MM-DD)
function formatMaxiDate(date) {
  return date.toISOString().split('T')[0];
}
```

**Why UTC?**: Maxi API expects dates in YYYY-MM-DD format without timezone info. Using UTC ensures consistent interpretation across servers in different timezones.

## Critical Workflows

### 1. Sales Sync Process

**Trigger**: Cron job daily at 04:15 AM (configurable via `CRON_SALES_SCHEDULE`)

**Flow**:
```
cron.js:syncAllBusinessesDaily()
  ├─ Query businesses with Maxi credentials
  ├─ For each business:
  │   ├─ Acquire advisory lock (prevent concurrent sync)
  │   ├─ Check sales_sync_state.initial_backfill_done
  │   ├─ If not done → ensureInitialBackfillOnce() (last 7 days)
  │   ├─ Else → runDailyAuto() (last_day + 1 to yesterday)
  │   ├─ Fetch from Maxi in 7-day windows (parallel)
  │   ├─ Normalize and upsert → app_sales, app_sales_items
  │   ├─ Rebuild aggregates → sales_daily, sales_daily_items
  │   ├─ Update sales_sync_state.last_daily_sync_at
  │   └─ Release advisory lock
  └─ Log summary: {ran, ok, fail}
```

**Important Files**:
- `/services/salesSyncPolicy.js:182` - Main sync orchestration
- `/services/maxiSalesService.js:45` - Fetch from Maxi
- `/services/salesStore.js:89` - Normalize and store

### 2. Business Onboarding

**Trigger**: `POST /api/businesses/:id/onboard`

**Flow**:
```
businessOnboarding.onboardNewBusiness(businessId)
  ├─ Validate Maxi credentials exist
  ├─ Import catalog:
  │   ├─ Fetch menu from Maxi → maxi_menu_cache
  │   ├─ Flatten hierarchy → articles array
  │   ├─ Create taxonomy → categorias, subrubros
  │   └─ Upsert → app_articles, maxi_article_map
  ├─ Initial sales sync:
  │   ├─ ensureInitialBackfillOnce(businessId, 7 days)
  │   └─ Mark initial_backfill_done in sales_sync_state
  └─ Return {ok, stats}
```

**File**: `/services/businessOnboarding.js:28`

### 3. Catalog Refresh

**Trigger**: `POST /api/businesses/:id/maxi-refresh-menu`

**Flow**:
```
catalogSyncService.syncCatalog(businessId)
  ├─ Fetch menu from Maxi (via maxiMenuService)
  ├─ Cache raw response → maxi_menu_cache
  ├─ Extract articles from hierarchy
  ├─ For each article:
  │   ├─ Ensure category exists → categorias
  │   ├─ Ensure subcategory exists → subrubros
  │   └─ Upsert article → app_articles
  ├─ Build mapping → maxi_article_map
  └─ Return {articlesCount}
```

**File**: `/services/catalogSyncService.js:67`

## Environment Variables Reference

### Required Variables

```bash
# Database
DATABASE_URL=postgresql://user:pass@host:port/dbname
PGDATABASE=lazarillo_app

# Authentication
JWT_SECRET=<64-char-hex>              # Generate: openssl rand -hex 32
ENCRYPTION_KEY=<64-char-hex>          # Generate: openssl rand -hex 32

# Maxi API
MAXI_BASE_URL=https://api-mconn.maxisistemas.com.ar
```

### Optional Variables

```bash
# Server
PORT=4000
NODE_ENV=production

# Database Optimization
PGPOOL_MAX=10
PG_CONN_TIMEOUT_MS=10000
PG_STATEMENT_TIMEOUT_MS=45000
PGSSLMODE=require                     # disable for local dev

# Maxi Sync Configuration
MAXI_MAX_WINDOW_DAYS=6                # Split large date ranges
MAXI_CONCURRENCY=2                    # Parallel Maxi requests
MAXI_RETRIES=3
MAXI_FETCH_TIMEOUT_MS=30000
INIT_BACKFILL_DAYS=7                  # Initial sync lookback

# Cron
CRON_ENABLED=1
CRON_TZ=America/Argentina/Buenos_Aires
CRON_SALES_SCHEDULE=15 4 * * *        # Daily at 04:15 AM
CRON_SECRET=<secret-for-api-trigger>

# Email (SMTP)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=email@domain.com
SMTP_PASS=<app-password>
MAIL_FROM="Lazarillo <email@domain.com>"

# Security
BCRYPT_ROUNDS=10
SERVICE_BEARER=<optional-service-token>

# Debugging
LOG_MAXI_RAW=1                        # Log raw Maxi responses
DB_SLOW_QUERY_MS=500                  # Log slow queries
```

## Testing and Debugging

### Manual Testing with curl

```bash
# 1. Register user
curl -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!","name":"Test User"}'

# 2. Login
TOKEN=$(curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!"}' \
  | jq -r '.token')

# 3. Create business
BIZ_ID=$(curl -X POST http://localhost:4000/api/businesses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"My Restaurant"}' \
  | jq -r '.business.id')

# 4. Set Maxi credentials
curl -X POST http://localhost:4000/api/businesses/$BIZ_ID/maxi-credentials \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email":"maxi@example.com","password":"maxipass","codcli":"12345"}'

# 5. Trigger onboarding
curl -X POST http://localhost:4000/api/businesses/$BIZ_ID/onboard \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Business-Id: $BIZ_ID"

# 6. Get sales data
curl -X GET "http://localhost:4000/api/ventas?groupBy=day" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Business-Id: $BIZ_ID"
```

### Debugging Maxi Integration

```bash
# Peek at Maxi API response (requires business ID)
npm run peek:maxi -- <businessId>

# Show cached menu
npm run cache:show -- <businessId>

# Trigger cron manually
npm run cron:now

# Test email configuration
curl http://localhost:4000/api/dev/test-mail
```

### Database Debugging

```sql
-- Check sync state
SELECT * FROM sales_sync_state WHERE business_id = 7;

-- See recent sales
SELECT * FROM app_sales
WHERE business_id = 7
ORDER BY occurred_at DESC
LIMIT 10;

-- Check daily aggregates
SELECT day, total, tx_count
FROM sales_daily
WHERE business_id = 7
ORDER BY day DESC
LIMIT 30;

-- View Maxi credentials (encrypted)
SELECT id, name, props->'maxi' AS maxi_config
FROM app_businesses
WHERE id = 7;

-- Check active advisory locks
SELECT locktype, pid, mode, granted
FROM pg_locks
WHERE locktype = 'advisory';
```

## Common Issues and Solutions

### Issue: "Faltan credenciales Maxi"

**Cause**: Missing or invalid Maxi credentials in `app_businesses.props.maxi`

**Solution**:
```javascript
// Verify credentials exist
const {rows} = await pool.query(`
  SELECT (props->'maxi'->>'email') AS email,
         (props->'maxi'->>'codcli') AS codcli,
         (props->'maxi' ? 'pass_enc') AS has_password
  FROM app_businesses WHERE id = $1
`, [businessId]);

// If missing, set via API:
POST /api/businesses/:id/maxi-credentials
{
  "email": "user@business.com",
  "password": "plaintext-password",
  "codcli": "12345"
}
```

### Issue: Sales sync stuck

**Cause**: Advisory lock held by crashed process

**Solution**:
```sql
-- Find locks
SELECT pid, locktype, mode
FROM pg_locks
WHERE locktype = 'advisory';

-- Force release (use with caution)
SELECT pg_advisory_unlock_all();

-- Or kill specific process
SELECT pg_terminate_backend(pid)
FROM pg_locks
WHERE locktype = 'advisory' AND pid = <pid>;
```

### Issue: Duplicate sales entries

**Should not happen**: Upserts are idempotent using `(business_id, external_id)` unique constraint.

**If it happens**:
```sql
-- Check for duplicates
SELECT external_id, COUNT(*)
FROM app_sales
WHERE business_id = 7
GROUP BY external_id
HAVING COUNT(*) > 1;

-- Manual cleanup (rebuild aggregates after)
DELETE FROM app_sales a USING app_sales b
WHERE a.id > b.id
  AND a.business_id = b.business_id
  AND a.external_id = b.external_id;

-- Rebuild aggregates
POST /api/businesses/7/sync-sales/rebuild-aggregates
```

### Issue: Slow sales queries

**Solutions**:
1. Check indexes exist (migrations should create them)
2. Use pre-aggregated `sales_daily` and `sales_daily_items` tables
3. Add date range filters (`WHERE day BETWEEN $1 AND $2`)
4. Increase connection pool: `PGPOOL_MAX=20`
5. Add materialized views for complex reports

## File Location Quick Reference

### Critical Files to Know

**Entry point**:
- `/home/user/LazarilloApp-Backend/app.js:1` - Express app setup, middleware, routes

**Database**:
- `/home/user/LazarilloApp-Backend/config/db.js:1` - Connection pool configuration
- `/home/user/LazarilloApp-Backend/db/migrations.js:1` - Migration orchestrator

**Authentication**:
- `/home/user/LazarilloApp-Backend/middleware/authMiddleware.js:1` - JWT validation
- `/home/user/LazarilloApp-Backend/controllers/authController.js:1` - Login/register

**Maxi Integration**:
- `/home/user/LazarilloApp-Backend/services/maxiSalesService.js:45` - Fetch sales
- `/home/user/LazarilloApp-Backend/services/maxiMenuService.js:67` - Fetch catalog
- `/home/user/LazarilloApp-Backend/services/maxiCredsService.js:23` - Credential management

**Sales Sync**:
- `/home/user/LazarilloApp-Backend/services/salesSyncPolicy.js:182` - Sync orchestration
- `/home/user/LazarilloApp-Backend/services/salesStore.js:89` - Data normalization
- `/home/user/LazarilloApp-Backend/services/cron.js:45` - Daily cron job

**Utilities**:
- `/home/user/LazarilloApp-Backend/utils/cryptoField.js:1` - AES-256-GCM encryption
- `/home/user/LazarilloApp-Backend/utils/pgRetry.js:1` - Database retry logic

## Best Practices for AI Assistants

### When Making Changes

1. **Always check business_id scope**: Every query should filter by `business_id`
2. **Use idempotent operations**: Prefer `ON CONFLICT DO UPDATE` over `INSERT`
3. **Add migrations**: Never modify schema without creating a migration file
4. **Test multi-tenancy**: Verify data isolation between businesses
5. **Handle Maxi errors gracefully**: Maxi API can be unstable, always retry
6. **Log comprehensively**: Use request IDs for tracing, log slow queries
7. **Consider performance**: Sales tables can have millions of rows, use indexes

### When Adding Features

1. **Follow existing patterns**: Check similar controllers/services first
2. **Update this doc**: Add new sections for significant features
3. **Add environment variables** to this doc if introduced
4. **Consider backward compatibility**: Don't break existing API contracts
5. **Think about scale**: Will this work with 1000+ businesses and millions of sales?

### When Debugging

1. **Check logs first**: Request IDs help trace execution flow
2. **Verify credentials**: Most Maxi errors are auth-related
3. **Check advisory locks**: Can cause "stuck" syncs
4. **Inspect raw data**: Use `maxi_*_cache` tables to see API responses
5. **Test with real Maxi data**: Sandbox environments may behave differently

## Version Information

- **Node.js**: 18+ required
- **PostgreSQL**: 13+ required (uses `GENERATED ALWAYS AS IDENTITY`, `JSONB`, extensions)
- **Express**: 5.x (note: some middleware changed from v4)

## Additional Resources

- **README.md**: Comprehensive project documentation (31k+ tokens)
- **db/migrations/live/**: Database schema definitions
- **scripts/**: Utility scripts for debugging and maintenance

---

**Last Updated**: 2025-12-09

**Maintainer**: Contact business owner for Maxi API access and credentials.
