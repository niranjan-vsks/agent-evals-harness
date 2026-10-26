import { createRouter, createWebHistory } from 'vue-router';
import CompareView from './views/CompareView.vue';
import ConfigsView from './views/ConfigsView.vue';
import ExperimentDetailView from './views/ExperimentDetailView.vue';
import ExperimentsView from './views/ExperimentsView.vue';
import OverviewView from './views/OverviewView.vue';
import TrialView from './views/TrialView.vue';

export const routes = [
  { path: '/', name: 'overview', component: OverviewView },
  { path: '/configs', name: 'configs', component: ConfigsView },
  { path: '/experiments', name: 'experiments', component: ExperimentsView },
  { path: '/experiments/:id', name: 'experiment', component: ExperimentDetailView, props: true },
  // ?a=&b= are config ids; the view falls back to the API's default pair for a 2-config experiment.
  { path: '/experiments/:id/compare', name: 'compare', component: CompareView, props: true },
  { path: '/trials/:id', name: 'trial', component: TrialView, props: true },
];

export const router = createRouter({ history: createWebHistory(), routes });
