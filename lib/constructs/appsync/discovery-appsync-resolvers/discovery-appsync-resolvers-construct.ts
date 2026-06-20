import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

export interface DiscoveryAppSyncResolversConstructProps {
  api: appsync.IGraphqlApi;
  searchProductsLambda?: lambda.IFunction;
  getFeedLambda?: lambda.IFunction;
  getCuratedCollectionLambda?: lambda.IFunction;
}

export class DiscoveryAppSyncResolversConstruct extends Construct {
  constructor(scope: Construct, id: string, props: DiscoveryAppSyncResolversConstructProps) {
    super(scope, id);

    if (props.searchProductsLambda) {
      const searchProductsDataSource = props.api.addLambdaDataSource(
        'SearchProductsDataSource',
        props.searchProductsLambda
      );

      searchProductsDataSource.createResolver('SearchProductsResolver', {
        typeName: 'Query',
        fieldName: 'searchShelfItems',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.getFeedLambda) {
      const getFeedDataSource = props.api.addLambdaDataSource(
        'GetFeedDataSource',
        props.getFeedLambda
      );

      getFeedDataSource.createResolver('GetFeedResolver', {
        typeName: 'Query',
        fieldName: 'getFeed',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

    if (props.getCuratedCollectionLambda) {
      const getCuratedCollectionDataSource = props.api.addLambdaDataSource(
        'GetCuratedCollectionDataSource',
        props.getCuratedCollectionLambda
      );

      getCuratedCollectionDataSource.createResolver('GetCuratedCollectionResolver', {
        typeName: 'Query',
        fieldName: 'getCuratedCollection',
        requestMappingTemplate: appsync.MappingTemplate.lambdaRequest(),
        responseMappingTemplate: appsync.MappingTemplate.lambdaResult(),
      });
    }

  }
}
