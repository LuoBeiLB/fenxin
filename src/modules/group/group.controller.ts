import { Body, Controller, Delete, Get, Param, Post, Put, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { GroupService } from './group.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateGroupDto, UpdateGroupDto, AddMembersDto, SetRoleDto, TransferOwnershipDto } from './dto';

@ApiTags('群组管理')
@ApiBearerAuth()
@Controller('groups')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  /** 管理员：全量群组列表（含群主信息、成员数、解散状态），管理后台群组管理页用 */
  @Get('admin/all')
  @Roles('admin')
  adminList(
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
    @Query('keyword') keyword?: string,
    @Query('include_dissolved') includeDissolved?: string,
  ) {
    return this.groupService.adminListGroups({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      keyword,
      includeDissolved: includeDissolved === 'true',
    });
  }

  /** 管理员：强制解散群（软解散：成员不可再发消息，消息记录保留供审计） */
  @Delete('admin/:id')
  @Roles('admin')
  @ResponseMessage('群组已解散')
  async dissolve(@CurrentUser() user: AuthPayload, @Param('id') id: string, @Req() req: Request) {
    await this.groupService.dissolveGroup(id, user.userId, req.ip);
    return null;
  }

  /** 群主：解散自己的群（解散即焚：全群消息到期由调度器物理清除，群记录保留） */
  @Delete(':id')
  @ResponseMessage('群组已解散')
  async dissolveByOwner(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    await this.groupService.dissolveGroupByOwner(id, user.userId);
    return null;
  }

  @Post()
  @ResponseMessage('群组创建成功')
  create(@CurrentUser() user: AuthPayload, @Body() dto: CreateGroupDto) {
    return this.groupService.createGroup({
      name: dto.name,
      description: dto.description,
      avatarUrl: dto.avatar_url,
      memberIds: dto.member_ids ?? [],
      ownerId: user.userId,
      isChannel: dto.is_channel,
    });
  }

  @Put(':id')
  @ResponseMessage('群组信息更新成功')
  update(@CurrentUser() user: AuthPayload, @Param('id') id: string, @Body() dto: UpdateGroupDto) {
    return this.groupService.updateGroupInfo(
      id,
      { name: dto.name, description: dto.description, avatarUrl: dto.avatar_url },
      user.userId,
    );
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthPayload, @Param('id') id: string) {
    return this.groupService.getGroupMembers(id, user.userId, user.role);
  }

  @Post(':id/members')
  @ResponseMessage('成员添加成功')
  async addMembers(@CurrentUser() user: AuthPayload, @Param('id') id: string, @Body() dto: AddMembersDto) {
    await this.groupService.addMembers(id, dto.member_ids, user.userId);
    return null;
  }

  @Delete(':id/members/:userId')
  @ResponseMessage('成员已移除')
  async removeMember(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.groupService.removeMember(id, userId, user.userId);
    return null;
  }

  @Put(':id/members/:userId/role')
  @ResponseMessage('角色设置成功')
  async setRole(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body() dto: SetRoleDto,
  ) {
    await this.groupService.setMemberRole(id, userId, dto.role, user.userId);
    return null;
  }

  /** 群主：把 owner 身份转给群内另一个成员 */
  @Post(':id/transfer')
  @ResponseMessage('群主已转让')
  async transferOwnership(
    @CurrentUser() user: AuthPayload,
    @Param('id') id: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    await this.groupService.transferOwnership(id, user.userId, dto.new_owner_id);
    return null;
  }
}
