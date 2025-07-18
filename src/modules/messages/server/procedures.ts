import { z } from "zod";
import { auth } from "@clerk/nextjs/server";
import { TRPCError } from "@trpc/server";
import { getSubscriptionToken } from "@inngest/realtime";

import { prisma } from "@/lib/db";
import { inngest } from "@/inngest/client";
import { fragmentChannel } from "@/inngest/functions";
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";
import {
  FREE_POINTS,
  GENERATION_COST,
  getUsageTracker,
  PRO_POINTS,
} from "@/lib/usage";

export const messagesRouter = createTRPCRouter({
  getMany: protectedProcedure
    .input(
      z.object({
        projectId: z
          .string()
          .uuid()
          .min(1, { message: "Project ID is required" }),
      })
    )
    .query(async ({ input, ctx }) => {
      const messages = await prisma.message.findMany({
        where: {
          projectId: input.projectId,
          project: {
            userId: ctx.auth.userId,
          },
        },
        orderBy: {
          updatedAt: "asc",
        },
        include: {
          fragment: true,
        },
      });

      return messages;
    }),
  create: protectedProcedure
    .input(
      z.object({
        value: z
          .string()
          .min(1, { message: "Message is required" })
          .max(10000, {
            message: "Message is too long",
          }),
        projectId: z
          .string()
          .uuid()
          .min(1, { message: "Project ID is required" }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.auth.userId;
      const { has } = await auth();

      const existingProject = await prisma.project.findUnique({
        where: {
          id: input.projectId,
          userId: userId,
        },
      });

      if (!existingProject) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }

      const userTracker = await getUsageTracker(userId, has);

      if (
        userTracker !== null &&
        userTracker.remainingPoints < GENERATION_COST
      ) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: "You don't have enough credits",
        });
      }

      const createdMessage = await prisma.message.create({
        data: {
          projectId: existingProject.id,
          content: input.value,
          role: "USER",
          type: "RESULT",
        },
      });

      const hasProAccess = has({ plan: "pro" });
      const effectivePoints = hasProAccess ? PRO_POINTS : FREE_POINTS;

      await inngest.send({
        name: "code-agent/run",
        data: {
          value: input.value,
          projectId: input.projectId,
          userId,
          effectivePoints,
        },
      });

      return createdMessage;
    }),
  getFragmentSubscriptionToken: protectedProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx }) => {
      const userId = ctx.auth.userId;

      const token = await getSubscriptionToken(inngest, {
        channel: fragmentChannel(userId),
        topics: ["completed", "error"],
      });

      return token;
    }),
});
