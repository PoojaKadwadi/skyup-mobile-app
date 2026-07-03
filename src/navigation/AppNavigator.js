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
import { useSafeAreaInsets }          from 'react-native-safe-area-context';

import LoginScreen         from '../screens/auth/LoginScreen';
import DashboardScreen     from '../screens/dashboard/DashboardScreen';
import LeadsScreen         from '../screens/leads/LeadsScreen';
import LeadDetailScreen    from '../screens/leads/LeadDetailScreen';
import CallLogsScreen      from '../screens/calls/CallLogsScreen';
import ClientMeetingScreen from '../screens/calls/ClientMeetingScreen'; // ← replaces RecordingsScreen
import ProfileScreen       from '../screens/dashboard/ProfileScreen';
import ClockInGate         from '../components/ClockInGate';
import TermsGate           from '../components/TermsGate';
import { useTheme }        from '../theme/ThemeContext';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

const SCREEN_OPTIONS = {
  headerShown:       false,
  gestureEnabled:    true,
  animation:         'slide_from_right',
  animationDuration: 250,
};

function MainTabs() {
  const { colors } = useTheme();
  // Bottom safe-area inset — non-zero on devices with a gesture pill / nav
  // bar. Without adding this, the fixed height:65 tab bar sits partly
  // (or fully) under the system nav bar, so the icons/labels for the last
  // row get clipped or hard to tap. We push the bar up by that inset and
  // add it on top of the resting padding instead of replacing it.
  const insets = useSafeAreaInsets();
  const tabBarBottomPad = Math.max(insets.bottom, 8);

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        lazy: true,
        tabBarActiveTintColor:   colors.blue,
        tabBarInactiveTintColor: colors.textSec,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor:  colors.border,
          borderTopWidth:  1,
          paddingBottom:   tabBarBottomPad,
          paddingTop:      8,
          height:          57 + tabBarBottomPad,
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

// Gated tabs — employee must accept Terms, then clock in, before the app shows.
function GatedMainTabs() {
  return (
    <TermsGate>
      <ClockInGate>
        <MainTabs />
      </ClockInGate>
    </TermsGate>
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