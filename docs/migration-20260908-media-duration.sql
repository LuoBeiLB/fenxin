-- v5.8.9 播完才焚（音视频 consume）：messages 表新增音视频时长列（单位：秒）
-- 语义：发送端上报（语音=录音秒数、视频=播放器 metadata duration）；焚毁消息 reveal 时
--       消费窗口 = max(burn_ttl_seconds, media_duration + BURN_MEDIA_BUFFER_SECONDS[默认30s])，
--       保证「10s 焚毁 + 30s 视频」能播完再焚。NULL = 未上报，reveal 走默认窗口 300s 兜底。
-- 说明：本文件与 src/database/migrations/1767600000000-AddMediaDuration.ts 等价；
--       npm run migration:run 会自动执行 TypeORM 版本，无需再手动跑本 SQL。
ALTER TABLE messages ADD COLUMN media_duration int NULL AFTER file_original_url;
