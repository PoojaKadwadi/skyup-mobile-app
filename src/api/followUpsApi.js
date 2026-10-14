// src/api/followUpsApi.js — NEW FILE
// The Daily Report's "Follow-ups" lists (pending follow-ups with the employee's note + leads with no follow-up date).
// Admins get every employee (optionally one via userId); an employee gets only their own.
import apiClient from './apiClient';

export async function fetchFollowUps({ userId } = {}) {
  const res = await apiClient.get('/reports/follow-ups', { params: userId ? { userId } : {} });
  return res.data;
}
