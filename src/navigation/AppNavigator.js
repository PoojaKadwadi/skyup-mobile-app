// src/navigation/AppNavigator.js
// CHANGE: Replaced RecordingsScreen → ClientMeetingScreen.
// The "Recordings" tab is gone; the new "Meeting" tab in the bottom nav
// points to ClientMeetingScreen where agents log client meeting remarks,
// attach documents/recordings, and set follow-up dates from the field.
//
// All perf fixes from the previous revision are retained:
//  • native-stack (UI-thread animations)
//  • static imports (no lazy/Suspense waterfall)
//  • gestureEnabled + slide_from_right animation

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator }   from '@react-navigation/bottom-tabs';
import { useSelector }                from 'react-redux';
import Icon                           from 'react-native-vector-icons/MaterialCommunityIcons';

import LoginScreen         from '../screens/auth/LoginScreen';
import DashboardScreen     from '../screens/dashboard/DashboardScreen';
import LeadsScreen         from '../screens/leads/LeadsScreen';
import LeadDetailScreen    from '../screens/leads/LeadDetailScreen';
import CallLogsScreen      from '../screens/calls/CallLogsScreen';
import ClientMeetingScreen from '../screens/calls/ClientMeetingScreen'; // ← replaces RecordingsScreen
import ProfileScreen       from '../screens/dashboard/ProfileScreen';
import ClockInGate         from '../components/ClockInGate';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

const SCREEN_OPTIONS = {
  headerShown:       false,
  gestureEnabled:    true,
  animation:         'slide_from_right',
  animationDuration: 250,
};

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        lazy: true,
        tabBarActiveTintColor:   '#2563EB',
        tabBarInactiveTintColor: '#94A3B8',
        tabBarStyle: {
          backgroundColor: '#0F172A',
          borderTopColor:  '#1E293B',
          borderTopWidth:  1,
          paddingBottom:   8,
          paddingTop:      8,
          height:          65,
        },
        tabBarLabelStyle: {
          fontSize:   11,
          fontWeight: '600',
          marginTop:  2,
        },
        tabBarIcon: ({ color, size, focused }) => {
          const icons = {
            Dashboard:   focused ? 'view-dashboard'      : 'view-dashboard-outline',
            Leads:       focused ? 'account-group'       : 'account-group-outline',
            'Call Logs': focused ? 'phone-log'           : 'phone-log',
            Meeting:     focused ? 'calendar-account'    : 'calendar-account-outline', // ← new
            Profile:     focused ? 'account-circle'      : 'account-circle-outline',
          };
          return <Icon name={icons[route.name] || 'circle'} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Dashboard"  component={DashboardScreen}     />
      <Tab.Screen name="Leads"      component={LeadsScreen}         />
      <Tab.Screen name="Call Logs"  component={CallLogsScreen}      />
      <Tab.Screen name="Meeting"    component={ClientMeetingScreen} />
      <Tab.Screen name="Profile"    component={ProfileScreen}       />
    </Tab.Navigator>
  );
}

// Gated tabs — employee must clock in before the bottom-tab app is shown.
function GatedMainTabs() {
  return (
    <ClockInGate>
      <MainTabs />
    </ClockInGate>
  );
}

export default function AppNavigator() {
  const user = useSelector((state) => state.auth.user);

  return (
    <Stack.Navigator screenOptions={SCREEN_OPTIONS}>
      {!user ? (
        <Stack.Screen name="Login"      component={LoginScreen}      />
      ) : (
        <>
          <Stack.Screen name="Main"       component={GatedMainTabs}    />
          <Stack.Screen name="LeadDetail" component={LeadDetailScreen} />
          {/* "Recordings" stack screen removed — ClientMeeting is now a tab */}
        </>
      )}
    </Stack.Navigator>
  );
}