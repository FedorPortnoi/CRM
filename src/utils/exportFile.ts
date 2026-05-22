import * as FileSystem from 'expo-file-system/legacy';

type ExportFileParams = {
  url: string;
  token: string;
  filename: string;
};

type ErrorEnvelope = {
  error?: {
    message?: string;
  };
  message?: string;
};

function safeFilename(filename: string): string {
  return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extractErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as ErrorEnvelope;
    return parsed.error?.message ?? parsed.message ?? `Export failed with status ${status}`;
  } catch {
    return `Export failed with status ${status}`;
  }
}

export async function downloadAuthenticatedPdf({
  url,
  token,
  filename,
}: ExportFileParams): Promise<string> {
  const baseDirectory = FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  if (!baseDirectory) {
    throw new Error('File storage is not available on this device.');
  }

  const fileUri = `${baseDirectory}${Date.now()}-${safeFilename(filename)}`;
  const result = await FileSystem.downloadAsync(url, fileUri, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/pdf',
    },
  });

  if (result.status < 200 || result.status >= 300) {
    let body = '';
    try {
      body = await FileSystem.readAsStringAsync(result.uri);
    } catch {
      body = '';
    }
    throw new Error(extractErrorMessage(body, result.status));
  }

  return result.uri;
}
