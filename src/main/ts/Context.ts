export interface File {
  path: string;
  size: number;
}

export interface Progress {
  description: string;
  completeRatio?: number;
}

export interface Context {
  file: File;
  concurrentUploads: number;
  maximumRetriesPerPart: number;
  resumeSession: () => Promise<Buffer | null>;
  writeSession: (session: Buffer) => Promise<void>;
  readState: (key: string) => Promise<Buffer | null>;
  writeState: (key: string, value: Buffer) => Promise<void>;
  logError: (message: string) => void;
  updateProgress: (progress: Progress) => void;
}
