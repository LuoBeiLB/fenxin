/**
 * Jest 启动钩子：注入单元测试环境变量，避免 dotenv 找不到 .env 时散落 warn。
 * 这些值只用于单元测试（不接 DB / 不发 token 到生产服务），无安全风险。
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-access-secret-must-be-at-least-32-chars-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-must-be-at-least-32-chars-long';
process.env.DESTROY_RECEIPT_SECRET = 'test-destroy-secret-must-be-at-least-32-chars-long';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '3306';
process.env.DB_DATABASE = 'burnmsg_test';
process.env.AUTH_CACHE_TTL_MS = '0'; // 默认关闭：单元测试更确定性
