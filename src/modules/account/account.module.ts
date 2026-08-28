import { Module } from '@nestjs/common';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { GroupModule } from '../group/group.module';

@Module({
  // GroupModule：注销账号时级联解散其为群主的群（GroupModule 无反向依赖，不构成循环）
  imports: [GroupModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
