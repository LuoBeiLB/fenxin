import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { DestroyService } from './destroy.service';
import { BurnScheduler } from './burn.scheduler';
import { OssModule } from '../upload/oss.module';

@Module({
  imports: [OssModule],
  controllers: [MessageController],
  providers: [MessageService, DestroyService, BurnScheduler],
  exports: [DestroyService],
})
export class MessageModule {}
