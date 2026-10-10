import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import {
  PHOTO_SLOT_MESSAGE,
  PHOTO_SLOTS,
  type PhotoSlot,
} from './dto/photo-upload-request.dto';

@Injectable()
export class ParsePhotoSlotPipe implements PipeTransform<string, PhotoSlot> {
  transform(value: string): PhotoSlot {
    const slot = PHOTO_SLOTS.find((candidate) => String(candidate) === value);
    if (slot === undefined) {
      throw new BadRequestException(PHOTO_SLOT_MESSAGE);
    }
    return slot;
  }
}
