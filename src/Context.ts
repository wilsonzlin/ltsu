export interface Progress {
  description: string;
  completeRatio: number;
}

export interface Session {
  uploadId: string;
  filePath: string;
  fileLastChanged: string;
  partSize: number;
  partsNeeded: number;
}

export interface Context {
  file: {
    path: string;
    size: number;
    // Use string for more reliable comparison than floating point numbers.
    lastModified: string;
  };
  force: boolean;
  concurrentUploads: number;
  resumeSession: () => Promise<Session | null>;
  writeSession: (session: Session) => Promise<void>;
  readState: (key: string) => Promise<Buffer | null>;
  writeState: (key: string, value: Buffer) => Promise<void>;
  log: (message: string, info?: boolean) => void;
  updateProgress: (progress: Progress) => void;
}
