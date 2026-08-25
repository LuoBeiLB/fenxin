import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AuthPayload } from '../../common/guards/jwt-auth.guard';

@ApiTags('通讯录')
@ApiBearerAuth()
@Controller('contacts')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  @Get()
  list(
    @CurrentUser() user: AuthPayload,
    @Query('keyword') keyword?: string,
    @Query('department') department?: string,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
  ) {
    return this.contactService.listContacts({
      userId: user.userId,
      keyword,
      department,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('search')
  search(@CurrentUser() user: AuthPayload, @Query('keyword') keyword?: string) {
    if (!keyword) throw new BadRequestException('keyword 不能为空');
    return this.contactService.searchContacts(user.userId, keyword);
  }
}
