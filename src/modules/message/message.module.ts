import { Module } from '@nestjs/common';
import { MessageController } from './message.controller';
import { MessageService } from './message.service';
import { BurnScheduler } from './burn.scheduler';

@Module({
  controllers: [MessageController],
  providers: [MessageService, BurnScheduler],
})
export class MessageModule {}
