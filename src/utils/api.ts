import Constants from 'expo-constants';

const API_URL: string = Constants.expoConfig?.extra?.apiUrl as string;

export { API_URL };
