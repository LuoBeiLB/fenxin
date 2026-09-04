-- ═══ v5.8.7 图片链路优化：双上传（压缩版 + 原图） ═══
-- 背景：服务器公网出带宽仅 5Mbps，历史图片消息聊天流直拉原图（几 MB）导致体验极卡。
-- 方案：前端选图后 canvas 压缩（长边 ≤1440 JPEG q0.82）先上传发消息（file_url=压缩版，秒开），
--       原图随后台上传，PATCH /messages/:id/original-file 回填本字段；「保存到相册」下载原图。
-- 兼容：NULL = 无原图（老消息/语音/视频/压缩失败直传），前端下载自动回退 file_url。
-- 执行：在后端实际连接的库执行（本地开发库 yy / 阿里云 burnmsg 各自执行一次）。

ALTER TABLE messages
  ADD COLUMN file_original_url VARCHAR(500) NULL DEFAULT NULL
  COMMENT '原图地址（v5.8.7 双上传：file_url=压缩版，此列=原图；NULL=无原图回退 file_url）'
  AFTER file_size;
