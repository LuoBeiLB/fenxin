# AGENTS.md —— 本仓库的开发约定

> 面向所有参与本仓库开发的工程师 / AI 助手。
> 违反约定的改动请在 PR 里显式说明理由。

---

## 1. 项目定位

- `fenxin-server`：焚信（BurnMsg）的 NestJS 后端
- 技术栈：NestJS 10 + TypeORM 0.3 + MySQL 8 + socket.io
- 已上线生产（Docker：`fenxin-mysql` / `fenxin-backend`）
- 前端仓库：[fenxin](https://github.com/LuoBeiLB/fenxin)（Vue 3 + Capacitor）

---

## 2. 兼容性策略（重要）

**本项目不做向后兼容。** 前端会随后端一起发版，因此：

| 允许 | 说明 |
|---|---|
| ✅ 直接改接口的请求/响应结构 | 前端同版本发版即可 |
| ✅ 直接删除不再使用的接口 | 同上 |
| ✅ 直接删除表 / 字段 | 必须通过迁移（见 §3） |
| ✅ 不做"新旧两套逻辑并存" | 不写 `if (oldClient)` 分支 |
| ✅ 不做数据迁移脚本保历史 | **用户不看重聊天记录**，历史数据丢失可接受 |

**唯一红线**：**不能影响用户登录与核心链路**。以下流程必须在发版后立即可用：

```
登录 → 设备注册 → 会话列表 → 发消息 → 收消息（WS）→ 已读 → 拉历史 → 退出登录
```

> 换句话说：删数据可以，删到用户登不上不行。

### 为什么这样定

- 产品侧明确：聊天记录不是核心资产（阅后即焚本身就是"不保留"的语义）
- 维持兼容代码的成本远高于收益（每个双写/双读分支都会长期留在代码里）
- 前端与后端由同一团队发布，可以保证原子上线

---

## 3. 数据库迁移（**每次改 schema 必须遵守**）

### 3.1 铁律

> **任何**表结构变更（建表、加列、删列、改类型、加索引、删索引、删表）**都必须写成迁移文件**，
> 不允许"上线前手工执行 SQL"，不允许只改实体不写迁移。

| 规则 | 说明 |
|---|---|
| 位置 | `src/database/migrations/<13位时间戳>-<PascalName>.ts` |
| 命名 | 时间戳递增，类名 `PascalName<时间戳>`，并设置 `name` 属性 |
| **幂等** | 必须用 `information_schema` 判断（`hasTable` / `hasColumn` / `hasIndex`），可重复执行 |
| `down()` | 必须实现；确实不可逆的（如 DROP TABLE）要在注释与 `down()` 里显式说明 |
| 本地验证 | `migration:run` → `migration:show`（全 `[X]`）→ `migration:revert` 再 `run` 各一次 |
| 不可修改历史迁移 | 已合入的迁移文件视为不可变；要改结构 → **新增**迁移 |
| 分批更新 | 存量数据回填要 `LIMIT` 分批（参考 `BurnV6SoftDelete` 的 `LIMIT 1000` 循环） |
| 大表 DDL | 加索引/加列在低峰执行；必要时 `ALGORITHM=INPLACE` |

### 3.2 迁移模板

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * <一句话说明为什么需要这个变更>
 *
 * 幂等：information_schema 判断。
 */
export class AddSomething1768200000000 implements MigrationInterface {
  name = 'AddSomething1768200000000';

  public async up(qr: QueryRunner): Promise<void> {
    if (!(await this.hasTable(qr, 'xxx'))) {
      await qr.query(`CREATE TABLE ...`);
    }
    if (!(await this.hasColumn(qr, 'messages', 'yyy'))) {
      await qr.query("ALTER TABLE `messages` ADD COLUMN `yyy` ...");
    }
  }

  public async down(qr: QueryRunner): Promise<void> {
    if (await this.hasColumn(qr, 'messages', 'yyy')) {
      await qr.query('ALTER TABLE `messages` DROP COLUMN `yyy`');
    }
  }

  private async hasTable(qr: QueryRunner, table: string): Promise<boolean> {
    const rows = await qr.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }

  private async hasColumn(qr: QueryRunner, table: string, column: string): Promise<boolean> {
    const rows = await qr.query(
      `SELECT COUNT(*) AS cnt FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
    return Number(rows?.[0]?.cnt ?? 0) > 0;
  }
}
```

### 3.3 执行

```bash
# 本地
node node_modules/typeorm/cli-ts-node-commonjs.js migration:run -d src/database/data-source.ts

# 生产（容器内，用编译产物）
docker exec fenxin-backend node node_modules/typeorm/cli.js migration:run -d dist/database/data-source.js
```

> 迁移的运维流程见 [docs/MIGRATION_RUNBOOK.md](./docs/MIGRATION_RUNBOOK.md)。

### 3.4 `DB_SYNC` 必须为 false

`synchronize` 会与迁移抢改表，**且实测会删除迁移创建的索引与生成列**。生产与开发环境都保持：

```bash
DB_SYNC=false
```

#### 为什么 DB_SYNC=true 会在「有生成列」的库上直接启动失败

2026-11-02 实际故障：`conversations.e2e_pair_key` 是数据库生成列（STORED GENERATED）。
TypeORM 在 **synchronize 模式**下读表结构时，会为每个生成列查询自己的簿记表：

```sql
SELECT * FROM typeorm_metadata
 WHERE type = 'GENERATED_COLUMN' AND name = 'e2e_pair_key' ...
```

而 `typeorm_metadata` 在本项目从来不存在（只用迁移，从没触发过 TypeORM 建表），
且这次查询发生在 TypeORM **建表之前** → 鸡生蛋，启动直接失败：

```
QueryFailedError: Table 'yy.typeorm_metadata' doesn't exist
[Nest] ERROR [TypeOrmModule] Unable to connect to the database. Retrying (1)...
```

**已由迁移 `1768200003000-AddTypeormMetadata` 补建该表**（并把现有生成列登记进去），
因此现在误开 `DB_SYNC=true` 也不会再启动失败 —— 但**仍然不要开**：
同步模式会把迁移建的 `uk_e2e_pair` / `idx_e2e_state` / `idx_e2e_devices` 与
`e2e_pair_key` 生成列全部删掉（本项目已实测复现多次）。

> 若已经误开过一次导致索引/生成列丢失：删掉对应迁移记录后重跑迁移即可自愈
> （迁移都带 `hasColumn`/`hasIndex` 判断，缺什么补什么）：
> `DELETE FROM typeorm_migrations WHERE name IN (...)` 然后 `migration:run`。

---

## 4. 代码约定

| 项 | 约定 |
|---|---|
| 包管理器 | **npm**（仓库只有 `package-lock.json`，不要用 pnpm） |
| 查询写法 | 先 `const qb = ...createQueryBuilder()`，再逐步 `qb.where(...)` / `qb.andWhere(...)`，最后终结方法；**不要长链式混用** |
| TypeORM 陷阱 | `where()` 会**清空**已加的 `andWhere()`；条件必须先 `where` 后 `andWhere` |
| 输出 DTO | 每个接口的响应都要有 `dto/response.ts` 里的类 + 明确返回类型，不用 `any` |
| 日志 | 正文用**英文 ASCII**（避免 GBK 终端乱码），注释用中文 |
| 错误码 | 业务异常用具体 `code` 字符串（如 `E2E_PAIR_EXISTS`），便于前端分支处理 |
| 敏感数据 | 日志、接口响应中不得出现 `cipher_text`、密码、密钥 |

---

## 5. 测试要求

| 改动类型 | 要求 |
|---|---|
| 新增/修改 service 方法 | 补单元测试（`test/modules/**`） |
| 改 schema | 跑全量测试 + 本地迁移验证 |
| 改接口契约 | 同步更新 `openapi.yaml` |
| 改 WS 事件 | 同步更新 `docs/websocket-events.md` |

```bash
# 测试必须串行（Windows 上并发会 spawn EPERM）
node node_modules/jest/bin/jest.js --ci --runInBand --coverage=false

# 类型检查
node node_modules/typescript/bin/tsc --noEmit
```

---

## 6. 文档

| 文档 | 何时更新 |
|---|---|
| `openapi.yaml` | 任何接口变更 |
| `docs/websocket-events.md` | 任何 WS 事件变更 |
| `docs/*_DESIGN.md` / 专题文档 | 设计变更 |
| `docs/MIGRATION_RUNBOOK.md` | 迁移流程变更 |
| `docs/DEPLOY_HANDOFF.md` | 发布流程变更 |

---

## 7. 提交规范

```
<type>(<scope>): <一句话标题>

## 背景
<为什么改>

## 改动
<改了什么，按文件/模块列>

## 验证
<怎么验证的：测试数量、手工验证步骤、迁移是否跑通>
```

`type`：`feat` / `fix` / `refactor` / `docs` / `test` / `chore`

---

## 8. 环境速查

| 项 | 值 |
|---|---|
| 生产 MySQL 容器 | `fenxin-mysql`（`mysql:8.4`） |
| 生产后端容器 | `fenxin-backend` |
| 生产库 / 用户 | `yy` / `fenxin` |
| API 端口 | `9091`（由 `fenxin-frontend` 反代） |
| 测试机 | `zzzzz@192.168.9.104`（测试库 `yy`，容器 `fenxin-mysql-test` / `fenxin-backend-test`） |
| 测试库导出/导入 | 见 `docs/TEST_REHEARSAL.md`（含中文编码坑） |
