import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { HookErrorFilter } from './hook-error.filter';

function capture(exception: unknown) {
  const res = {
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  new HookErrorFilter().catch(exception, host);
  return res;
}

describe('HookErrorFilter', () => {
  it('renders HttpExceptions with their status and message', () => {
    const res = capture(new NotFoundException('gone'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('application/json');
    expect(res.json).toHaveBeenCalledWith({
      error: { http_code: 404, message: 'gone' },
    });
  });

  it('joins validation message arrays', () => {
    const res = capture(new BadRequestException(['a is bad', 'b is bad']));
    expect(res.json).toHaveBeenCalledWith({
      error: { http_code: 400, message: 'a is bad; b is bad' },
    });
  });

  it('uses a string response as the message', () => {
    const res = capture(new HttpException('teapot', 418));
    expect(res.json).toHaveBeenCalledWith({
      error: { http_code: 418, message: 'teapot' },
    });
  });

  it('falls back to the exception message for an object response without one', () => {
    const res = capture(new HttpException({ detail: 'x' }, 409));
    expect(res.json).toHaveBeenCalledWith({
      error: { http_code: 409, message: 'Http Exception' },
    });
  });

  it('hides unexpected errors behind a generic 500', () => {
    const res = capture(new Error('secret stack detail'));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: { http_code: 500, message: 'Internal server error' },
    });
  });
});
