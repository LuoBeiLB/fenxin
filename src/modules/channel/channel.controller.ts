import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ChannelService } from './channel.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateChannelDto, UpdateChannelDto, DiscoverChannelsQueryDto } from './dto';

@ApiTags('个人频道')
@ApiBearerAuth()
@Controller('channels')
export class ChannelController {
  constructor(private readonly channelService: ChannelService) {}

  /** 创建我的频道（一人一个）：个人空间，订阅后可看内容流 */
  @Post()
  @ResponseMessage('频道创建成功')
  create(@CurrentUser() user: AuthPayload, @Body() dto: CreateChannelDto) {
    return this.channelService.createChannel({
      name: dto.name,
      description: dto.description,
      avatarUrl: dto.avatar_url,
      ownerId: user.userId,
    });
  }

  /** 我的频道资料（未创建返回 404，前端引导去创建） */
  @Get('mine')
  mine(@CurrentUser() user: AuthPayload) {
    return this.channelService.getMyChannel(user.userId);
  }

  /** 频道广场：全部公开频道 + 我的订阅状态，热门优先，分页 */
  @Get('discover')
  discover(@CurrentUser() user: AuthPayload, @Query() query: DiscoverChannelsQueryDto) {
    return this.channelService.listDiscover(
      user.userId,
      query.page ?? 1,
      query.pageSize ?? 20,
    );
  }

  /** 频道详情：未订阅只返回元信息；消息走 /messages/:conversationId（未订阅会被 403） */
  @Get(':id')
  detail(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.channelService.getChannelDetail(id, user.userId);
  }

  /** 修改频道资料（仅频道主） */
  @Patch(':id')
  @ResponseMessage('频道资料已更新')
  update(@CurrentUser() user: AuthPayload, @Param('id') id: string, @Body() dto: UpdateChannelDto) {
    return this.channelService.updateChannel(id, user.userId, {
      name: dto.name,
      description: dto.description,
      avatarUrl: dto.avatar_url,
      visibility: dto.visibility,
    });
  }

  /** 订阅频道（公开频道，幂等） */
  @Post(':id/subscribe')
  @ResponseMessage('订阅成功')
  subscribe(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.channelService.subscribe(id, user.userId);
  }

  /** 退订频道（幂等；频道主不可退订自己的频道） */
  @Delete(':id/subscribe')
  @ResponseMessage('已退订')
  unsubscribe(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.channelService.unsubscribe(id, user.userId);
  }

  /** 解散频道（仅频道主）：解散即焚，订阅者会话列表立即移除，内容流随后物理清除 */
  @Delete(':id')
  @ResponseMessage('频道已解散')
  async dissolveByOwner(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    await this.channelService.dissolveChannel(id, user.userId);
    return null;
  }
}
