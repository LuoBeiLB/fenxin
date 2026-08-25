import {
  BadRequestException,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import { extname } from 'path';
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
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) =>
          cb(null, require('path').resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads')),
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
