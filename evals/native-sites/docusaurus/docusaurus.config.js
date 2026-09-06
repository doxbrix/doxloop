export default {
  title: 'Existing product manual', url: 'https://docs.example.test', baseUrl: '/manual/',
  i18n: { defaultLocale: 'en', locales: ['en'] },
  onBrokenLinks: 'throw', trailingSlash: true,
  themeConfig: { navbar: { title: 'Manual', logo: { src: 'img/export.svg', href: '/help/' } } },
  presets: [['classic', { docs: { path: 'content', routeBasePath: '/help', sidebarPath: './sidebars.js' }, blog: false }]],
};
