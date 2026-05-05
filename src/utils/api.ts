import Constants from 'expo-constants';

const API_URL: string = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? 'http://localhost:3000/api/v1';

function getApiUrl(): string {
  return API_URL;
}

export { API_URL, getApiUrl };
