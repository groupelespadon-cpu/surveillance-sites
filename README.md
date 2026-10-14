# Surveillance des sites du Groupe L'Espadon

Une sonde qui regarde, toutes les cinq minutes et depuis Internet, les sites
spa-groupelespadon.com, 1temporelle.com et northwave-spa.com, comme le ferait
un client. Elle prévient par e-mail quand une page ne s'affiche plus, qu'un
certificat ou un nom de domaine arrive à expiration, ou que la sonde installée
sur le serveur ne donne plus de nouvelles. Un second mail part quand c'est
réglé.

- `sites.json` : ce qui est contrôlé.
- `sonde.mjs` : le contrôle, sans dépendance.
- `etat.json` : ce qui est en cours, écrit par la sonde elle-même.

Le dépôt est public pour que les contrôles soient gratuits. Il ne contient ni
mot de passe ni donnée de client : la clé d'envoi des e-mails est un secret du
dépôt, invisible ici.

La sonde du serveur (mémoire, disque, bases, sécurité) vit sur le serveur
lui-même ; son code est dans `scripts/surveillance/` du dépôt du site.
