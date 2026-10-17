import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

/** `<FLY_MACHINE_ID or "local">-<random>`: unique to one process. */
export function exportOwnerId(machineId: string | undefined): string {
  return `${machineId?.trim() || 'local'}-${randomUUID().slice(0, 8)}`;
}

/** Identifies this process as the owner of the exports it queues and runs. */
@Injectable()
export class DocumentExportOwner {
  readonly id = exportOwnerId(process.env.FLY_MACHINE_ID);
}
