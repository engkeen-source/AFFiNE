import type {
  CanActivate,
  ExecutionContext,
  FactoryProvider,
  OnModuleInit,
} from '@nestjs/common';
import { Injectable, SetMetadata } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Socket } from 'socket.io';

import {
  AccessDenied,
  AuthenticationRequired,
  Config,
  CryptoHelper,
  getRequestResponseFromContext,
  parseCookies,
} from '../../base';
import { WEBSOCKET_OPTIONS } from '../../base/websocket';
import { AuthService } from './service';
import { Session } from './session';

const PUBLIC_ENTRYPOINT_SYMBOL = Symbol('public');
const INTERNAL_ENTRYPOINT_SYMBOL = Symbol('internal');

@Injectable()
export class AuthGuard implements CanActivate, OnModuleInit {
  private auth!: AuthService;

  constructor(
    private readonly crypto: CryptoHelper,
    private readonly ref: ModuleRef,
    private readonly reflector: Reflector
  ) {}

  onModuleInit() {
    this.auth = this.ref.get(AuthService, { strict: false });
  }

  async canActivate(context: ExecutionContext) {
    const { req, res } = getRequestResponseFromContext(context);
    const clazz = context.getClass();
    const handler = context.getHandler();

    // Debug logging for request tracing - enhanced to show more details
    console.log(`[AUTH DEBUG] Request from IP: ${req.ip || 'unknown'}`);
    console.log(
      `[AUTH DEBUG] Request path: ${req.method} ${req.originalUrl || req.url}`
    );

    // Check for Supabase user ID first - ALWAYS prioritize this
    const supabaseUserIdHeader = req.headers['x-supabase-user-id'];
    if (supabaseUserIdHeader) {
      const userId = Array.isArray(supabaseUserIdHeader)
        ? supabaseUserIdHeader[0]
        : supabaseUserIdHeader;

      console.log(`[AUTH DEBUG] Found x-supabase-user-id header: ${userId}`);

      // Delete any existing session to ensure we use the correct Supabase user
      delete req.session;

      // Get the user session based on the Supabase user ID
      const session = await this.auth.getSessionByUserId(userId);
      if (session) {
        req.session = session;
        console.log(`[AUTH DEBUG] Set session for Supabase user ID: ${userId}`);
      } else {
        console.log(
          `[AUTH DEBUG] No session found for Supabase user ID: ${userId}, creating one`
        );
        // Will be created by AuthService.getUserSessionFromRequest
      }
    } else {
      console.log(`[AUTH DEBUG] No x-supabase-user-id header found`);
    }

    // rpc request is internal
    const isInternal = this.reflector.getAllAndOverride<boolean>(
      INTERNAL_ENTRYPOINT_SYMBOL,
      [clazz, handler]
    );
    if (isInternal) {
      // check access token: data,signature
      const accessToken = req.get('x-access-token');
      if (accessToken && this.crypto.verify(accessToken)) {
        return true;
      }
      throw new AccessDenied('Invalid internal request');
    }

    const userSession = await this.signIn(req, res);

    // Debug logging for user session
    if (userSession?.user) {
      console.log(
        `[AUTH DEBUG] Authenticated user: ${userSession.user.id} (${userSession.user.email})`
      );
    } else {
      console.log(`[AUTH DEBUG] No authenticated user for this request`);
    }

    if (res && userSession && userSession.expiresAt) {
      await this.auth.refreshUserSessionIfNeeded(res, userSession);
    }

    // api is public
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ENTRYPOINT_SYMBOL,
      [clazz, handler]
    );

    if (isPublic) {
      return true;
    }

    if (!userSession) {
      throw new AuthenticationRequired();
    }

    return true;
  }

  async signIn(req: Request, res?: Response): Promise<Session | null> {
    // Debug logging for auth tracing
    const headerKeys = Object.keys(req.headers).join(', ');
    console.log(`[AUTH DEBUG] Headers: ${headerKeys}`);

    // If we have a Supabase user ID header, we should always use it
    const supabaseUserId = req.headers['x-supabase-user-id'];
    if (supabaseUserId && typeof supabaseUserId === 'string') {
      console.log(
        `[AUTH DEBUG] Found x-supabase-user-id header: ${supabaseUserId}`
      );

      // Clear any existing session to ensure we use the correct Supabase user
      delete req.session;

      // Get the user session based on the Supabase user ID
      const userSession = await this.auth.getUserSessionFromRequest(req, res);

      if (userSession) {
        // Verify that the session user matches the Supabase user ID
        if (userSession.user.id !== supabaseUserId) {
          console.log(
            `[AUTH DEBUG] Session user ID ${userSession.user.id} doesn't match header user ID ${supabaseUserId}`
          );
          delete req.session;
          // Retry with only the Supabase user ID
          return this.auth.getUserSessionFromRequest(req, res).then(session => {
            if (session) {
              req.session = {
                ...session.session,
                user: session.user,
              };
              return req.session;
            }
            return null;
          });
        }

        req.session = {
          ...userSession.session,
          user: userSession.user,
        };
        return req.session;
      }
      return null;
    }

    // Fall back to existing session handling if no Supabase user ID
    if (req.session) {
      return req.session;
    }

    // For non-Supabase auth flows
    const userSession = await this.auth.getUserSessionFromRequest(req, res);

    if (userSession) {
      req.session = {
        ...userSession.session,
        user: userSession.user,
      };
      return req.session;
    }

    return null;
  }
}

/**
 * Mark api to be public accessible
 */
export const Public = () => SetMetadata(PUBLIC_ENTRYPOINT_SYMBOL, true);

/**
 * Mark rpc api to be internal accessible
 */
export const Internal = () => SetMetadata(INTERNAL_ENTRYPOINT_SYMBOL, true);

export const AuthWebsocketOptionsProvider: FactoryProvider = {
  provide: WEBSOCKET_OPTIONS,
  useFactory: (config: Config, guard: AuthGuard) => {
    return {
      ...config.websocket,
      canActivate: async (socket: Socket) => {
        const upgradeReq = socket.client.request as Request;
        const handshake = socket.handshake;

        // compatibility with websocket request
        parseCookies(upgradeReq);

        upgradeReq.cookies = {
          [AuthService.sessionCookieName]: handshake.auth.token,
          [AuthService.userCookieName]: handshake.auth.userId,
          ...upgradeReq.cookies,
        };

        const session = await guard.signIn(upgradeReq);

        return !!session;
      },
    };
  },
  inject: [Config, AuthGuard],
};
