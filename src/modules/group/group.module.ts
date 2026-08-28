import { Module } from '@nestjs/common';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

@Module({
  controllers: [GroupController],
  providers: [GroupService],
  // 导出供 AccountModule 注入：账号注销时需级联解散其为群主的群
  exports: [GroupService],
})
export class GroupModule {}
