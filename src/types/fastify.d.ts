import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      sub: string;
      org_id: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
      iat: number;
      exp: number;
    };
    user: {
      sub: string;
      org_id: string;
      role: 'owner' | 'admin' | 'member' | 'viewer';
      iat: number;
      exp: number;
    };
  }
}
