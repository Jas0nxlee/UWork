export interface ZipExtractionOptions {
  dir: string;
  defaultDirMode?: number | string;
  defaultFileMode?: number | string;
  onEntry?(entry: { fileName: string }, archive: unknown): void | Promise<void>;
}
export type ZipExtractor = (zipPath: string, options: ZipExtractionOptions) => Promise<void>;
