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

/**
 * 文件上传：multipart 字段名 file，限制 50MB。
 * 存本地 UPLOAD_DIR，经 /uploads/<filename> 静态访问。
 * 图片自动生成 480 宽 webp 缩略图（uploads/thumb/），返回 thumb_url：
 * 聊天列表加载缩略图（几十 KB）、点开大图加载原图；
 * 历史消息/生成失败/非图片时 thumb_url 为 null，前端回退用 url 即原图。
 * 后续迭代：MinIO 对象存储 + 分片断点续传。
 */
@ApiTags('文件上传')
@ApiBearerAuth()
@Controller('upload')
export class UploadController {
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
    return {
      url: `/uploads/${file.filename}`,
      thumb_url: await this.makeThumb(file),
      // multer 对中文文件名按 latin1 解码，这里转回 utf8
      file_name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      file_size: file.size,
    };
  }

  /**
   * 图片缩略图：480 宽 webp（质量 75，典型 30~80KB），存 uploads/thumb/<原名>_thumb.webp。
   * - gif 跳过（保留动图，thumb_url 为 null 直接走原图）；
   * - 小于 480 宽的图不放大（withoutEnlargement）；
   * - 生成失败不影响上传成功，返回 null 由前端回退原图。
   */
  private async makeThumb(file: Express.Multer.File): Promise<string | null> {
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
      return `/uploads/thumb/${base}_thumb.webp`;
    } catch {
      return null;
    }
  }
}
