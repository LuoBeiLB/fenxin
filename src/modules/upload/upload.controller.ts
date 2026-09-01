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
import { extname, resolve } from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

/**
 * 文件上传：multipart 字段名 file，限制 50MB。
 * 存本地 UPLOAD_DIR，经 /uploads/<filename> 静态访问。
 * 后续迭代：MinIO 对象存储 + 分片断点续传。
 */
@ApiTags('文件上传')
@ApiBearerAuth()
@Controller('upload')
export class UploadController {
  @Post()
  // 上传限流：同一 IP 每分钟最多 10 个文件（50MB 上限 → 磁盘写入 500MB/分封顶），
  // 正常用户无感，防公网滥用（V5.8 补充，此前该接口仅靠全局限流兜底）
  @Throttle({ default: { limit: 10, ttl: 60000 } })
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
  upload(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('未接收到文件');
    return {
      url: `/uploads/${file.filename}`,
      // multer 对中文文件名按 latin1 解码，这里转回 utf8
      file_name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
      file_size: file.size,
    };
  }
}
