import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { useAppStore } from './stores/app';
import './styles.css';

const app = createApp(App);
app.use(createPinia());
useAppStore().applyBase();
app.use(router);
app.mount('#app');
