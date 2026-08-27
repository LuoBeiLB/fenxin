import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AccountService } from './account.service';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ResponseMessage } from '../../common/decorators/response-message.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';
import {
  CreateAccountDto,
  BatchCreateDto,
  ResetPasswordDto,
  ToggleStatusDto,
  ListAccountsQuery,
} from './dto';

@ApiTags('账号管理')
@ApiBearerAuth()
@Roles('admin')
@Controller('accounts')
export class AccountController {
  constructor(private readonly accountService: AccountService) {}

  @Post()
  @ResponseMessage('账号开通成功')
  create(@Body() dto: CreateAccountDto, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.accountService.createAccount({
      phone: dto.phone,
      displayName: dto.display_name,
      department: dto.department,
      password: dto.password,
      operatorId: user.userId,
      ip: req.ip,
    });
  }

  @Post('batch')
  @ResponseMessage('批量导入完成')
  batchCreate(@Body() dto: BatchCreateDto, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    return this.accountService.batchCreateAccounts(dto.accounts, user.userId, req.ip);
  }

  /** Excel 批量导入：multipart 上传 xlsx，列名支持 phone/手机号, display_name/姓名, department/部门 */
  @Post('import')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }))
  @ResponseMessage('Excel 导入完成')
  importExcel(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    if (!file) throw new BadRequestException('未接收到文件');
    return this.accountService.importFromExcel(file.buffer, user.userId, req.ip);
  }

  @Post(':id/reset-password')
  @ResponseMessage('密码重置成功')
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetPasswordDto,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    return this.accountService.resetPassword(id, user.userId, dto.new_password, req.ip);
  }

  @Post(':id/toggle-status')
  @ResponseMessage('状态更新成功')
  async toggleStatus(
    @Param('id') id: string,
    @Body() dto: ToggleStatusDto,
    @CurrentUser() user: AuthPayload,
    @Req() req: Request,
  ) {
    await this.accountService.toggleAccountStatus(id, dto.status, user.userId, req.ip);
    return null;
  }

  @Get()
  list(@Query() query: ListAccountsQuery) {
    return this.accountService.listAccounts({ ...query, showDeleted: query.show_deleted });
  }

  /**
   * 软删除账号：标记 deleted_at，数据保留但不可登录、不在通讯录显示。
   * 关联会话、消息、群组关系保留供审计；前端需二次确认（输入手机号确认）。
   */
  @Delete(':id')
  @ResponseMessage('账号已删除')
  async remove(@Param('id') id: string, @CurrentUser() user: AuthPayload, @Req() req: Request) {
    await this.accountService.softDeleteAccount(id, user.userId, req.ip);
    return null;
  }

  /** 注意：必须声明在 @Get(':id') 之前，否则 /departments 会被 /:id 抢占（旧版 bug） */
  @Get('departments')
  departments() {
    return this.accountService.listDepartments();
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.accountService.getAccount(id);
  }
}
