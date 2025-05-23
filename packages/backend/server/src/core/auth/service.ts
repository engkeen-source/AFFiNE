import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import type { CookieOptions, Request, Response } from 'express';
import { assign, pick } from 'lodash-es';

import { Config, SignUpForbidden } from '../../base';
import { Models, type User, type UserSession } from '../../models';
import { FeatureService } from '../features';
import { Mailer } from '../mail/mailer';
import { createDevUsers } from './dev';
import type { CurrentUser } from './session';

export function sessionUser(
  user: Pick<
    User,
    'id' | 'email' | 'avatarUrl' | 'name' | 'emailVerifiedAt' | 'disabled'
  > & { password?: string | null }
): CurrentUser {
  // use pick to avoid unexpected fields
  return assign(pick(user, 'id', 'email', 'avatarUrl', 'name', 'disabled'), {
    hasPassword: user.password !== null,
    emailVerified: user.emailVerifiedAt !== null,
  });
}

function extractTokenFromHeader(authorization: string) {
  if (!/^Bearer\s/i.test(authorization)) {
    return;
  }

  return authorization.substring(7);
}

@Injectable()
export class AuthService implements OnApplicationBootstrap {
  readonly cookieOptions: CookieOptions = {
    sameSite: 'lax',
    httpOnly: true,
    path: '/',
    secure: this.config.server.https,
  };
  static readonly sessionCookieName = 'affine_session';
  static readonly userCookieName = 'affine_user_id';

  constructor(
    private readonly config: Config,
    private readonly models: Models,
    private readonly mailer: Mailer,
    private readonly feature: FeatureService
  ) {}

  async onApplicationBootstrap() {
    if (env.dev) {
      await createDevUsers(this.models);
    }
  }

  async canSignIn(email: string) {
    return await this.feature.canEarlyAccess(email);
  }

  /**
   * @deprecated
   *
   * This is a test only helper to quickly signup a user, do not use in production
   */
  async signUp(email: string, password: string): Promise<CurrentUser> {
    if (!env.testing) {
      throw new SignUpForbidden(
        'sign up helper is forbidden for non-test environment'
      );
    }

    return this.models.user
      .create({
        email,
        password,
      })
      .then(sessionUser);
  }

  async signIn(email: string, password: string): Promise<CurrentUser> {
    return this.models.user.signIn(email, password).then(sessionUser);
  }

  async signOut(sessionId: string, userId?: string) {
    // sign out all users in the session
    if (!userId) {
      await this.models.session.deleteSession(sessionId);
    } else {
      await this.models.session.deleteUserSessions(userId, sessionId);
    }
  }

  async getUserSession(
    sessionId: string,
    userId?: string
  ): Promise<{ user: CurrentUser; session: UserSession } | null> {
    const sessions = await this.getUserSessions(sessionId);

    if (!sessions.length) {
      return null;
    }

    let userSession: UserSession | undefined;

    // try read from user provided cookies.userId
    if (userId) {
      userSession = sessions.find(s => s.userId === userId);
    }

    // fallback to the first valid session if user provided userId is invalid
    if (!userSession) {
      // checked
      // oxlint-disable-next-line @typescript-eslint/no-non-null-assertion
      userSession = sessions.at(-1)!;
    }

    const user = await this.models.user.get(userSession.userId);

    if (!user) {
      return null;
    }

    return { user: sessionUser(user), session: userSession };
  }

  async getUserSessions(sessionId: string) {
    return await this.models.session.findUserSessionsBySessionId(sessionId);
  }

  async createUserSession(userId: string, sessionId?: string, ttl?: number) {
    return await this.models.session.createOrRefreshUserSession(
      userId,
      sessionId,
      ttl
    );
  }

  async getUserList(sessionId: string) {
    const sessions = await this.models.session.findUserSessionsBySessionId(
      sessionId,
      {
        user: true,
      }
    );
    return sessions.map(({ user }) => sessionUser(user));
  }

  async createSession() {
    return await this.models.session.createSession();
  }

  async getSession(sessionId: string) {
    return await this.models.session.getSession(sessionId);
  }

  /**
   * Get a user session by user ID, creating one if it doesn't exist
   * This is used for Supabase authentication
   */
  async getSessionByUserId(userId: string): Promise<UserSession | null> {
    if (!userId) {
      return null;
    }

    // Check if user exists
    const user = await this.models.user.get(userId);
    if (!user) {
      return null; // User doesn't exist yet - will be created in getUserSessionFromRequest
    }

    // Find all sessions for this user and find the one with this userId
    const allSessions =
      await this.models.session.createOrRefreshUserSession(userId);
    return allSessions;
  }

  async refreshUserSessionIfNeeded(
    res: Response,
    userSession: UserSession,
    ttr?: number
  ): Promise<boolean> {
    const newExpiresAt = await this.models.session.refreshUserSessionIfNeeded(
      userSession,
      ttr
    );
    if (!newExpiresAt) {
      // no need to refresh
      return false;
    }

    res.cookie(AuthService.sessionCookieName, userSession.sessionId, {
      expires: newExpiresAt,
      ...this.cookieOptions,
    });

    return true;
  }

  async revokeUserSessions(userId: string) {
    return await this.models.session.deleteUserSessions(userId);
  }

  getSessionOptionsFromRequest(req: Request) {
    // Always prefer x-supabase-user-id header for userId if present
    const supabaseUserIdHeader = req.headers['x-supabase-user-id'];
    let userId: string | undefined = undefined;
    if (typeof supabaseUserIdHeader === 'string') {
      userId = supabaseUserIdHeader;
    } else if (Array.isArray(supabaseUserIdHeader)) {
      userId = supabaseUserIdHeader[0];
    }

    // If not present, fallback to old cookie logic (for admin/dev only)
    if (!userId) {
      userId =
        req.cookies[AuthService.userCookieName] ||
        req.headers[AuthService.userCookieName.replaceAll('_', '-')];
    }

    // SessionId is not needed in new mode, but keep for compatibility
    let sessionId: string | undefined = undefined;
    if (req.cookies[AuthService.sessionCookieName]) {
      sessionId = req.cookies[AuthService.sessionCookieName];
    } else if (req.headers.authorization) {
      sessionId = extractTokenFromHeader(req.headers.authorization);
    }

    return {
      sessionId,
      userId,
    };
  }

  async setCookies(req: Request, res: Response, userId: string) {
    const { sessionId } = this.getSessionOptionsFromRequest(req);

    const userSession = await this.createUserSession(userId, sessionId);

    res.cookie(AuthService.sessionCookieName, userSession.sessionId, {
      ...this.cookieOptions,
      expires: userSession.expiresAt ?? void 0,
    });

    this.setUserCookie(res, userId);
  }

  async refreshCookies(res: Response, sessionId?: string) {
    if (sessionId) {
      const users = await this.getUserList(sessionId);
      const candidateUser = users.at(-1);

      if (candidateUser) {
        this.setUserCookie(res, candidateUser.id);
        return;
      }
    }

    this.clearCookies(res);
  }

  private clearCookies(res: Response<any, Record<string, any>>) {
    res.clearCookie(AuthService.sessionCookieName);
    res.clearCookie(AuthService.userCookieName);
  }

  setUserCookie(res: Response, userId: string) {
    res.cookie(AuthService.userCookieName, userId, {
      ...this.cookieOptions,
      // user cookie is client readable & writable for fast user switch if there are multiple users in one session
      // it safe to be non-secure & non-httpOnly because server will validate it by `cookie[AuthService.sessionCookieName]`
      httpOnly: false,
      secure: false,
    });
  }

  async getUserSessionFromRequest(req: Request, res?: Response) {
    const { userId } = this.getSessionOptionsFromRequest(req);
    if (!userId) {
      return null;
    }

    // Check if user exists, if not create them
    let user = await this.models.user.get(userId);
    if (!user) {
      // Auto-create user for Supabase auth
      user = await this.models.user.create({
        id: userId,
        email: `${userId}@supabase.local`,
        name: `User ${userId.slice(0, 8)}`,
        emailVerifiedAt: new Date(),
      });
      // Auto-create a personal workspace for this user
      const workspace = await this.models.workspace.create(userId);
      // Add user as owner of the workspace
      await this.models.workspaceUser.setOwner(workspace.id, userId);
    }

    // Always create or fetch a session for this userId
    const userSession = await this.createUserSession(userId);

    if (res) {
      this.setUserCookie(res, userId);
    }

    return { user: sessionUser(user), session: userSession };
  }

  async changePassword(
    id: string,
    newPassword: string
  ): Promise<Omit<User, 'password'>> {
    return this.models.user.update(id, { password: newPassword });
  }

  async changeEmail(
    id: string,
    newEmail: string
  ): Promise<Omit<User, 'password'>> {
    return this.models.user.update(id, {
      email: newEmail,
      emailVerifiedAt: new Date(),
    });
  }

  async setEmailVerified(id: string) {
    return await this.models.user.update(id, {
      emailVerifiedAt: new Date(),
    });
  }

  async sendChangePasswordEmail(email: string, callbackUrl: string) {
    return await this.mailer.send({
      name: 'ChangePassword',
      to: email,
      props: {
        url: callbackUrl,
      },
    });
  }
  async sendSetPasswordEmail(email: string, callbackUrl: string) {
    return await this.mailer.send({
      name: 'SetPassword',
      to: email,
      props: {
        url: callbackUrl,
      },
    });
  }
  async sendChangeEmail(email: string, callbackUrl: string) {
    return await this.mailer.send({
      name: 'ChangeEmail',
      to: email,
      props: {
        url: callbackUrl,
      },
    });
  }
  async sendVerifyChangeEmail(email: string, callbackUrl: string) {
    return await this.mailer.send({
      name: 'VerifyChangeEmail',
      to: email,
      props: {
        url: callbackUrl,
      },
    });
  }
  async sendVerifyEmail(email: string, callbackUrl: string) {
    return await this.mailer.send({
      name: 'VerifyEmail',
      to: email,
      props: {
        url: callbackUrl,
      },
    });
  }
  async sendNotificationChangeEmail(email: string) {
    return await this.mailer.send({
      name: 'EmailChanged',
      to: email,
      props: {
        to: email,
      },
    });
  }

  async sendSignInEmail(
    email: string,
    link: string,
    otp: string,
    signUp: boolean
  ) {
    return await this.mailer.send({
      name: signUp ? 'SignUp' : 'SignIn',
      to: email,
      props: {
        url: link,
        otp,
      },
    });
  }
}
