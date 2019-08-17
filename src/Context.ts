import {Session} from "./upload/session";

export interface Progress {
  description: string;
  completeRatio: number;
}

export interface Context {
  file: {
    path: string;
    size: number;
  };
  concurrentUploads: number;
  resumeSession: () => Promise<Session | null>;
  writeSession: (session: Session) => Promise<void>;
  readState: (key: string) => Promise<Buffer | null>;
  writeState: (key: string, value: Buffer) => Promise<void>;
  logError: (message: string) => void;
  updateProgress: (progress: Progress) => void;
}
