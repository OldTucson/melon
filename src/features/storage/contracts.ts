export interface BrowserOssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  region: string;
  bucket: string;
  endpoint: string;
  cname: boolean;
}

export interface BrowserCredentialIssuer {
  issue(input: {
    ownerId: string;
    patternId: string;
    objectKeys?: readonly string[];
  }): Promise<BrowserOssCredentials>;
}

export interface OssAdapter {
  listObjectKeys(prefix: string): Promise<string[]>;
  headObject(key: string): Promise<{
    sizeBytes: number;
    contentType: string;
  }>;
  readRange(
    key: string,
    start: number,
    endInclusive: number,
  ): Promise<Uint8Array>;
  deleteObjects(keys: string[]): Promise<void>;
  deleteObjectsUnderPrefix(prefix: string, keys: string[]): Promise<void>;
  createSignedGet(input: {
    key: string;
    filename: string;
    expiresSeconds: number;
  }): Promise<string>;
}

export interface OssConnectionConfig {
  region: string;
  bucket: string;
  endpoint: string;
  cname: boolean;
}

export interface BrowserCredentialIssuerConfig extends OssConnectionConfig {
  roleArn: string;
}
