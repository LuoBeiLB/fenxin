import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { diskStorage } from 'multer';
import { extname, resolve } from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { Request } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { AppVersionService } from './app-version.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateAppVersionDto, UpdateAppVersionDto, APP_PLATFORMS, AppPlatform } from './dto';

/**
 * App 版本管理（V5.8 App 自更新）。
 *
 * - 用户端 GET /app-versions/latest：App 启动自检更新（公开 + 限流）。
 * - 管理端 POST/GET/PATCH/DELETE：管理后台发版、撤回、强更开关。
 * - 管理员发布 / 恢复发布 / 切换强更时，WS 广播 app:update 给全部在线用户。
 */
@ApiTags('App 版本管理')
@ApiBearerAuth()
@Controller('app-versions')
export class AppVersionController {
  constructor(private readonly appVersionService: AppVersionService) {}

  /**
   * 用户端：检查更新。公开接口（App 启动时可能尚未登录），限流 30 次/分/IP。
   * 可选 platform=android|ios（默认 android）；current_code=客户端当前 versionCode，
   * 已是最新则 data 为 null。
   */
  @Get('latest')
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  latest(
    @Query('platform') platform?: string,
    @Query('current_code') currentCode?: number,
  ) {
    const pf: AppPlatform = (APP_PLATFORMS as readonly string[]).includes(platform)
      ? (platform as AppPlatform)
      : 'android';
    const code =
      currentCode !== undefined && currentCode !== null && !Number.isNaN(Number(currentCode))
        ? Number(currentCode)
        : undefined;
    return this.appVersionService.latestForClient(pf, code);
  }

  /** 管理端：版本列表（倒序分页） */
  @Get('manage')
  @Roles('admin')
  adminList(@Query('page') page?: number, @Query('pageSize') pageSize?: number) {
    return this.appVersionService.adminList(
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }

  /**
   * 管理端：上传 APK 并发布新版本（multipart：file + version_name + version_code + force? + notes?）。
   * 发版低频操作，限流 5 次/分/IP。
   */
  @Post()
  @Roles('admin')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiConsumes('multipart/form-data')
  @ResponseMessage('版本发布成功')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        // multer 的 diskStorage 不会自动建目录：必须先创建 uploads/app/，否则首次上传 ENOENT 直接 500
        destination: (_req, _file, cb) => {
          const dir = resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads', 'app');
          fs.mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
      }),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  publish(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateAppVersionDto,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    return this.appVersionService.publishVersion({
      file,
      dto,
      operatorId: user.userId,
      ip: req.ip,
    });
  }

  /** 管理端：修改版本（force / notes / published 撤回恢复） */
  @Patch(':id')
  @Roles('admin')
  @ResponseMessage('版本信息已更新')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppVersionDto,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    return this.appVersionService.updateVersion(id, dto, user.userId, req.ip);
  }

  /** 管理端：删除版本记录（磁盘 APK 文件保留，避免已分发链接立即失效） */
  @Delete(':id')
  @Roles('admin')
  @ResponseMessage('版本记录已删除')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    await this.appVersionService.deleteVersion(id, user.userId, req.ip);
    return null;
  }
}
