import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { GroupService } from './group.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import { CreateGroupDto, UpdateGroupDto, AddMembersDto, SetRoleDto } from './dto';

@ApiTags('群组管理')
@ApiBearerAuth()
@Controller('groups')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

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
    return this.groupService.getGroupMembers(id, user.userId);
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
}
