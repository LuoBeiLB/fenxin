import { Global, Module } from '@nestjs/common';
import { OssService } from './oss.service';

/** 全局模块：OssService 全应用可注入（UploadController / MessageService / BurnScheduler 等） */
@Global()
@Module({
  providers: [OssService],
  exports: [OssService],
})
export class OssModule {}
