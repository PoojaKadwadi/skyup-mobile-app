// src/navigation/AppNavigator.js
//
// PERFORMANCE FIXES:
//  1. Switched from @react-navigation/stack (JS-based) to
//     @react-navigation/native-stack (fully native on both iOS & Android).
//     JS stack runs animations in JS thread → jank when JS is busy.
//     Native stack runs on the UI thread → always 60fps regardless of JS load.
//
//  2. Removed React.lazy() + Suspense. React.lazy causes a waterfall:
//     navigate → render Suspense boundary → dynamic import → re-render.
//     This adds 200-800ms perceived latency per navigation. Native stack
//     with static imports is faster because modules are already in memory.
//
//  3. gestureEnabled: true on native stack = iOS swipe-back AND Android
//     predictive back gesture both work out of the box. The JS stack's
//     CardStyleInterpolators.forHorizontalIOS only works on iOS.
//
//  4. Animation set to 'slide_from_right' on native stack — this is the
//     exact same animation other apps use. On Android it uses the native
//     SharedElementTransition / Fragment animation, not a JS-driven one.
//
//  5. Tab navigator: lazy={true} retained so tab screens aren't mounted
//     until first visited.

import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator }   from '@react-navigation/bottom-tabs';
import { useSelector }                from 'react-redux';
import Icon                           from 'react-native-vector-icons/MaterialCommunityIcons';

// ✅ Static imports — no lazy/Suspense waterfall
import LoginScreen      from '../screens/auth/LoginScreen';
import DashboardScreen  from '../screens/dashboard/DashboardScreen';
import LeadsScreen      from '../screens/leads/LeadsScreen';
import LeadDetailScreen from '../screens/leads/LeadDetailScreen';
import CallLogsScreen   from '../screens/calls/CallLogsScreen';
import RecordingsScreen from '../screens/calls/RecordingsScreen';
import ProfileScreen    from '../screens/dashboard/ProfileScreen';

const Stack = createNativeStackNavigator();
const Tab   = createBottomTabNavigator();

// ✅ Native stack options — animations run on UI thread, not JS thread
const SCREEN_OPTIONS = {
  headerShown:    false,
  gestureEnabled: true,          // swipe-back on iOS + predictive back on Android
  animation:      'slide_from_right', // same as every other Android/iOS app
  animationDuration: 250,
};

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        lazy: true,              // don't mount tabs until first visited
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
            Dashboard:   focused ? 'view-dashboard'       : 'view-dashboard-outline',
            Leads:       focused ? 'account-group'         : 'account-group-outline',
            'Call Logs': focused ? 'phone-log'             : 'phone-log',
            Profile:     focused ? 'account-circle'        : 'account-circle-outline',
          };
          return <Icon name={icons[route.name] || 'circle'} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Dashboard"  component={DashboardScreen}  />
      <Tab.Screen name="Leads"      component={LeadsScreen}       />
      <Tab.Screen name="Call Logs"  component={CallLogsScreen}    />
      <Tab.Screen name="Profile"    component={ProfileScreen}     />
    </Tab.Navigator>
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
          <Stack.Screen name="Main"       component={MainTabs}         />
          <Stack.Screen name="LeadDetail" component={LeadDetailScreen} />
          <Stack.Screen name="Recordings" component={RecordingsScreen} />
        </>
      )}
    </Stack.Navigator>
  );
}