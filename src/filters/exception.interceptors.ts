import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpException,
    HttpStatus,
  } from '@nestjs/common'
//   import * as Sentry from '@sentry/node'
  
  @Catch()
  export class AllExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
      console.log(exception)
    //   Sentry.captureException(exception)
      if (host.getType() === 'http') {
        const ctx = host.switchToHttp()
        const response = ctx.getResponse()
  
        const httpStatus =
          exception instanceof HttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR
  
        if (exception instanceof HttpException) {
          console.log(exception.getResponse())
        }
  
        const errMsg = (
          exception instanceof HttpException
            ? typeof exception.getResponse() === 'string'
              ? exception.getResponse()
              : exception.getResponse()['message']
            : exception instanceof Error
            ? exception.message
            : 'internal error'
        ).toString()
  
        if (exception instanceof Error) {
          exception.message
        }
        const responseBody = {
          err: httpStatus,
          errMsg: errMsg,
        }
        response.json(responseBody)
      }
    }
  }
  