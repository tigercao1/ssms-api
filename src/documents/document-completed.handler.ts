import type {
  DocumentAssignmentRow,
  DocumentTemplateRow,
} from './documents.types';

/** A `sign` document that has just been completed and stored. */
export interface SignedDocument {
  assignment: DocumentAssignmentRow;
  template: DocumentTemplateRow;
  /** The exact signed, flattened PDF that was stored. */
  pdf: Buffer;
  /** SHA-256 of `pdf`, as recorded in `signed_sha256`. */
  sha256: string;
}

/**
 * Optional provider called once per completed `sign` document, after the
 * signed copy is stored and the assignment is marked completed (for example
 * to email the signer their copy). Failures are logged and never undo the
 * completion. Provide it in `DocumentsModule` with this class as the token.
 */
export abstract class DocumentCompletedHandler {
  abstract documentCompleted(document: SignedDocument): Promise<void>;
}
