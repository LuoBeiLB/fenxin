import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname, join, resolve } from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { OssService } from './oss.service';

/**
 * 文件上传：multipart 字段名 file，限制 50MB。
 * v5.9.0 OSS 外置存储：先落本地（sharp 压缩依赖本地文件），原图 + 缩略图经内网上传 OSS
 * （同地域免流量、不占公网出带宽），成功后删除本地副本，返回外网签名 URL。
 * 前端 utils/format.js 的 fileURL() 对 http(s) 开头的地址直通，无需改造；
 * 历史消息（本地 /uploads/ 相对路径）继续走静态服务，互不影响。
 * OSS 未启用（OSS_ENABLED=false）或任一上传失败：自动回退本地 UPLOAD_DIR，
 * 经 /uploads/<filename> 静态访问（与旧版行为一致，可用性优先）。
 */
@ApiTags('文件上传')
@ApiBearerAuth()
@Controller('upload')
export class UploadController {
  constructor(private readonly oss: OssService) {}

  @Post()
  // 上传限流：同一 IP 每分钟最多 30 个文件（50MB 上限 → 磁盘写入封顶 1.5GB/分）。
  // 正常聊天连发图片无感（一次连选 9 张 + 补几张也够），公网滥用仍有兜底；
  // 公网上线前再评估改为按用户 ID 限流（公司出口共享公网 IP 场景下更公平）。
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        // multer 的 diskStorage 不会自动建目录：uploads/ 不存在时（新服务器首传）会 ENOENT，先建目录
        destination: (_req, _file, cb) => {
          const dir = resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('未接收到文件');
    // multer 对中文文件名按 latin1 解码，这里转回 utf8
    const file_name = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const thumb = await this.makeThumb(file);

    // ---- v5.9.0：OSS 启用时原图 + 缩略图推 OSS，成功删本地副本并返回签名 URL ----
    if (this.oss.enabled) {
      try {
        const uploadDir = resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
        const fileKey = `uploads/${file.filename}`;
        const putFile = await this.oss.put(fileKey, join(uploadDir, file.filename));
        let thumb_url: string | null = null;
        if (thumb) {
          const thumbKey = `uploads/thumb/${thumb.base}_thumb.webp`;
          const putThumb = await this.oss.put(thumbKey, thumb.absPath);
          thumb_url = putThumb.url;
        }
        // 全部成功 → 删除本地副本（原图 + 缩略图），避免磁盘双份存储
        try {
          fs.unlinkSync(join(uploadDir, file.filename));
          if (thumb) fs.unlinkSync(thumb.absPath);
        } catch {
          // 删本地失败不影响本次上传结果
        }
        return { url: putFile.url, thumb_url, file_name, file_size: file.size };
      } catch {
        // OSS 任一步失败 → 降级本地（文件已落磁盘），可用性优先；
        // OSS 可能残留已传成功的对象（孤儿），存储成本可忽略不计
      }
    }

    // ---- 本地模式（OSS 关闭 / OSS 失败降级）：与旧版返回结构完全一致 ----
    return {
      url: `/uploads/${file.filename}`,
      thumb_url: thumb ? `/uploads/thumb/${thumb.base}_thumb.webp` : null,
      file_name,
      file_size: file.size,
    };
  }

  /**
   * 图片缩略图：480 宽 webp（质量 75，典型 30~80KB），存 uploads/thumb/<原名>_thumb.webp。
   * - gif 跳过（保留动图，thumb_url 为 null 直接走原图）；
   * - 小于 480 宽的图不放大（withoutEnlargement）；
   * - 生成失败不影响上传成功，返回 null 由前端回退原图。
   * 返回 { base, absPath }：base 用于拼 URL 路径，absPath 供 OSS 上传与本地副本清理。
   */
  private async makeThumb(
    file: Express.Multer.File,
  ): Promise<{ base: string; absPath: string } | null> {
    const mime = file.mimetype || '';
    if (!mime.startsWith('image/') || mime === 'image/gif') return null;
    try {
      const thumbDir = resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads', 'thumb');
      fs.mkdirSync(thumbDir, { recursive: true });
      const base = file.filename.replace(/\.[^.]+$/, '');
      const thumbPath = join(thumbDir, `${base}_thumb.webp`);
      await sharp(file.path)
        .resize({ width: 480, withoutEnlargement: true })
        .webp({ quality: 75 })
        .toFile(thumbPath);
      return { base, absPath: thumbPath };
    } catch {
      return null;
    }
  }
}
