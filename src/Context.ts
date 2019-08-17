export interface Progress {
  description: string;
  completeRatio: number;
}

export interface Session {
  uploadId: string;
  filePath: string;
  fileLastChanged: number;
  partSize: number;
  partsNeeded: number;
}

export interface Context {
  file: {
    path: string;
    size: number;
    lastModified: number;
  };
  concurrentUploads: number;
  resumeSession: () => Promise<Session | null>;
  writeSession: (session: Session) => Promise<void>;
  readState: (key: string) => Promise<Buffer | null>;
  writeState: (key: string, value: Buffer) => Promise<void>;
  log: (message: string, info?: boolean) => void;
  updateProgress: (progress: Progress) => void;
}
