import { Controller, Get, Render } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';

@Controller()
export class AppController {
  constructor() {}

  @SkipThrottle(true)
  @Get()
  @Render('index')
  index() {
    return;
  }
}
